"""
Data collection:
  1. Spotify  -> liked songs with the exact time each was added
  2. ReccoBeats -> valence + energy by Spotify track ID (primary)
  3. Last.fm  -> mood tags for songs ReccoBeats doesn't know (fallback)

Every lookup is cached in data/mood_cache.json so later runs only fetch
songs you liked since the last run.
"""

import json
import logging
import re
import threading
import time
from pathlib import Path

import requests

import mood

log = logging.getLogger("sources")

RECCOBEATS_URL = "https://api.reccobeats.com/v1/audio-features"
RECCOBEATS_BATCH = 40          # halved automatically if the API rejects a batch
LASTFM_URL = "https://ws.audioscrobbler.com/2.0/"
LASTFM_MIN_INTERVAL = 0.25     # Last.fm asks for at most ~5 requests/second
MISS_RETRY_DAYS = 30           # re-ask ReccoBeats about unknown songs after this

HTTP = requests.Session()
HTTP.headers["User-Agent"] = "mood-timeline/1.0 (personal project)"


# --------------------------------------------------------------------------- cache

class Cache:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        self.data = {}
        if path.exists():
            try:
                self.data = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError) as exc:
                log.warning("Cache unreadable, starting fresh: %s", exc)

    def get(self, bucket, key):
        return self.data.get(bucket, {}).get(key)

    def put(self, bucket, key, value):
        with self.lock:
            self.data.setdefault(bucket, {})[key] = value

    def save(self):
        with self.lock:
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.data), encoding="utf-8")
            tmp.replace(self.path)


# --------------------------------------------------------------------------- spotify

def fetch_liked_songs(sp, progress):
    """All liked songs, newest first (Spotify's order). Local files are skipped."""
    songs, offset, total = [], 0, None
    while True:
        page = sp.current_user_saved_tracks(limit=50, offset=offset)
        total = page.get("total", total)
        for item in page.get("items", []):
            t = item.get("track") or {}
            if not t.get("id") or t.get("is_local"):
                continue
            images = (t.get("album") or {}).get("images") or []
            songs.append({
                "id": t["id"],
                "name": t.get("name", ""),
                "artists": [a.get("name", "") for a in t.get("artists", [])],
                "album": (t.get("album") or {}).get("name", ""),
                "image": images[-1]["url"] if images else None,        # smallest
                "image_large": images[0]["url"] if images else None,
                "url": (t.get("external_urls") or {}).get("spotify"),
                "added_at": item.get("added_at"),
            })
        offset += 50
        progress("Reading your liked songs", min(offset, total or offset), total or offset)
        if not page.get("next"):
            break
    return songs


# --------------------------------------------------------------------------- reccobeats

def _spotify_id_from(item):
    """ReccoBeats items carry the Spotify link in `href`; be lenient about shape."""
    for key in ("href", "spotifyUrl", "spotify_url"):
        val = item.get(key)
        if isinstance(val, str) and "open.spotify.com/track/" in val:
            return val.rsplit("/", 1)[-1].split("?")[0]
    for key in ("spotifyId", "spotify_id"):
        if item.get(key):
            return item[key]
    return None


def _reccobeats_request(ids):
    """Returns (status_code, list_of_items). Retries politely on 429."""
    for attempt in range(5):
        r = HTTP.get(RECCOBEATS_URL, params={"ids": ",".join(ids)}, timeout=30)
        if r.status_code == 429:
            wait = float(r.headers.get("Retry-After", 2 + attempt * 2))
            log.info("ReccoBeats rate limit, waiting %.1fs", wait)
            time.sleep(wait)
            continue
        if r.status_code == 404:
            return 404, []
        if r.status_code >= 400:
            return r.status_code, []
        body = r.json()
        items = body.get("content", body) if isinstance(body, dict) else body
        return 200, items if isinstance(items, list) else []
    return 429, []


def fetch_reccobeats(ids, cache: Cache, progress):
    """Fill cache['reccobeats'] for ids. Hits store features, misses store a timestamp."""
    now = time.time()
    todo = []
    for sid in ids:
        entry = cache.get("reccobeats", sid)
        if entry is None:
            todo.append(sid)
        elif "miss" in entry and now - entry["miss"] > MISS_RETRY_DAYS * 86400:
            todo.append(sid)

    done = 0
    batch = RECCOBEATS_BATCH
    queue = [todo[i:i + batch] for i in range(0, len(todo), batch)]
    first_logged = False

    while queue:
        chunk = queue.pop(0)
        status, items = _reccobeats_request(chunk)

        if status >= 400 and status != 404 and len(chunk) > 1:
            # Maybe the batch is too large or one ID is malformed: split and retry.
            half = len(chunk) // 2
            queue[:0] = [chunk[:half], chunk[half:]]
            continue

        if items and not first_logged:
            log.info("ReccoBeats sample item keys: %s", sorted(items[0].keys()))
            first_logged = True

        found = set()
        for item in items:
            sid = _spotify_id_from(item)
            if sid in chunk and item.get("valence") is not None and item.get("energy") is not None:
                cache.put("reccobeats", sid, {
                    "valence": float(item["valence"]),
                    "energy": float(item["energy"]),
                    "tempo": item.get("tempo"),
                    "danceability": item.get("danceability"),
                    "acousticness": item.get("acousticness"),
                })
                found.add(sid)

        if items and not found:
            log.warning("ReccoBeats answered but no IDs matched. First item: %s",
                        json.dumps(items[0])[:400])

        for sid in chunk:
            if sid not in found:
                cache.put("reccobeats", sid, {"miss": now})

        done += len(chunk)
        progress("Looking up audio mood on ReccoBeats", done, len(todo))
        time.sleep(0.2)

    cache.save()


# --------------------------------------------------------------------------- last.fm

_last_call = [0.0]

NOISE = re.compile(
    r"\s*[\(\[](?:feat\.?|ft\.?|with|from|remaster|remastered|live|mono|stereo|"
    r"radio edit|single version|album version|deluxe|bonus)[^\)\]]*[\)\]]"
    r"|\s+-\s+(?:\d{4}\s+)?(?:remaster|remastered|live|mono|stereo|radio edit|"
    r"single version|album version|bonus track).*$",
    re.IGNORECASE,
)


def clean_title(title: str) -> str:
    cleaned = NOISE.sub("", title).strip()
    return cleaned or title


def _lastfm(method, api_key, **params):
    wait = LASTFM_MIN_INTERVAL - (time.time() - _last_call[0])
    if wait > 0:
        time.sleep(wait)
    _last_call[0] = time.time()
    params.update(method=method, api_key=api_key, format="json", autocorrect=1)
    try:
        r = HTTP.get(LASTFM_URL, params=params, timeout=20)
        body = r.json()
    except (requests.RequestException, ValueError) as exc:
        log.warning("Last.fm %s failed: %s", method, exc)
        return []
    if "error" in body:
        if body["error"] in (10, 26):   # invalid / suspended API key
            raise RuntimeError(f"Last.fm rejected the API key: {body.get('message')}")
        return []
    tags = (body.get("toptags") or {}).get("tag") or []
    if isinstance(tags, dict):          # a single tag comes back as an object
        tags = [tags]
    return [{"name": t.get("name", ""), "count": t.get("count", 0)} for t in tags[:25]]


def fetch_lastfm(songs, api_key, cache: Cache, progress):
    """Tags for each song: track tags first, the main artist's tags if those are useless."""
    for i, s in enumerate(songs, 1):
        artist = s["artists"][0] if s["artists"] else ""
        title = clean_title(s["name"])
        tkey = f"{artist.lower()}\u241f{title.lower()}"

        if cache.get("lastfm_track", tkey) is None:
            cache.put("lastfm_track", tkey, _lastfm("track.getTopTags", api_key,
                                                    artist=artist, track=title))
        track_tags = cache.get("lastfm_track", tkey)
        scored = mood.score_tags(track_tags)

        if not scored or not scored["has_mood_tag"]:
            akey = artist.lower()
            if cache.get("lastfm_artist", akey) is None:
                cache.put("lastfm_artist", akey, _lastfm("artist.getTopTags", api_key,
                                                         artist=artist))
            artist_scored = mood.score_tags(cache.get("lastfm_artist", akey))
            if artist_scored and (not scored or artist_scored["has_mood_tag"]):
                artist_scored["confidence"] = round(min(artist_scored["confidence"], 0.4), 3)
                s["_lastfm"] = ("lastfm-artist", artist_scored)
            elif scored:
                s["_lastfm"] = ("lastfm-track", scored)
        else:
            s["_lastfm"] = ("lastfm-track", scored)

        if i % 25 == 0:
            cache.save()
        progress("Filling gaps with Last.fm tags", i, len(songs))
    cache.save()


# --------------------------------------------------------------------------- pipeline

def attach_moods(songs, cache: Cache, lastfm_key, progress):
    """
    songs: dicts with name, artists and optionally spotify_id.
    Adds valence, energy, source, confidence and tags to each song in place.
    """
    fetch_reccobeats([s["spotify_id"] for s in songs if s.get("spotify_id")], cache, progress)

    def features(s):
        return cache.get("reccobeats", s["spotify_id"]) or {} if s.get("spotify_id") else {}

    missing = [s for s in songs if "valence" not in features(s)]
    if missing and lastfm_key:
        fetch_lastfm(missing, lastfm_key, cache, progress)

    for s in songs:
        rb = features(s)
        lf = s.pop("_lastfm", None)
        if "valence" in rb:
            s.update(valence=rb["valence"], energy=rb["energy"], source="reccobeats",
                     confidence=1.0, tags=[])
        elif lf:
            src, sc = lf
            s.update(valence=sc["valence"], energy=sc["energy"], source=src,
                     confidence=sc["confidence"], tags=sc["matched"])
        else:
            s.update(valence=None, energy=None, source=None, confidence=0, tags=[])


def build_spotify(sp, lastfm_key, data_dir: Path, progress):
    cache = Cache(data_dir / "mood_cache.json")
    liked = fetch_liked_songs(sp, progress)
    liked.sort(key=lambda r: r["added_at"] or "")

    songs = []
    for s in liked:
        song = {k: v for k, v in s.items() if k != "added_at"}
        song["spotify_id"] = s["id"]
        songs.append(song)
    attach_moods(songs, cache, lastfm_key, progress)
    cache.save()

    return {
        "provider": "spotify",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "lastfm_enabled": bool(lastfm_key),
        "songs": songs,
        "likes": [[i, s["added_at"]] for i, s in enumerate(liked)],
        "plays": [],
    }
