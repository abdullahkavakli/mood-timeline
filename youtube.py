"""
YouTube Music from a Google Takeout export.

  history/watch-history.json  -> every YouTube Music play with its exact time
                                 (or watch-history.html, converted on upload)
  playlists/*.csv             -> liked songs with the time each was liked

Takeout translates folder and file names into the account's language
("izleme geçmişi.html" in Turkish), so names are matched against a small lexicon.

YouTube has no mood data and no Spotify IDs, so each song is matched to Spotify
by title + artist (when Spotify is connected) to look up ReccoBeats features,
and falls back to Last.fm tags otherwise.
"""

import csv
import html
import json
import logging
import os
import re
import shutil
import tempfile
import time
import unicodedata
import zipfile
from collections import Counter
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from pathlib import Path

import requests

import sources

log = logging.getLogger("youtube")

VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
URL_ID = re.compile(r"[?&]v=([A-Za-z0-9_-]{11})")
OEMBED_URL = "https://www.youtube.com/oembed"
MATCH_THRESHOLD = 0.75
LIKES_HINTS = ("liked", "likes", "beğen", "begen", "gefällt", "me gusta", "j'aime",
               "curtid", "mi piace", "понрав")
HISTORY_NAMES = ("watch-history", "izleme geçmişi")
WATCH_WRAPPERS = (("Watched ", ""), ("", " adlı videoyu izlediniz"))   # for tiny histories
# Takeout sections whose CSVs hold video IDs but aren't playlists.
NOT_PLAYLISTS = ("comments", "subscriptions", "channels", "live chats",
                 "yorumlar", "abonelikler", "kanallar", "canlı sohbetler")

# HTML history dates, day first ("30 Eyl 2026 22:51:52 GMT+03:00") or month first
# ("Sep 30, 2026, 10:51:52 PM GMT-07:00"). Zone names like "PDT" are ambiguous: no match.
HTML_TIME = re.compile(
    r"(?:(\d{1,2})\.? ([^\W\d_]+)\.?|([^\W\d_]+)\.? (\d{1,2}),?) (\d{4}),? "
    r"(\d{1,2}):(\d{2}):(\d{2}) ?([AP]M)? ?(?:GMT|UTC)([+-]\d{1,2}(?::?\d{2})?)?(?=\s|\(|$)",
    re.IGNORECASE,
)
MONTHS = {name: n for n, names in enumerate(
    (("jan", "oca"), ("feb", "şub"), ("mar",), ("apr", "nis"), ("may",), ("jun", "haz"),
     ("jul", "tem"), ("aug", "ağu"), ("sep", "eyl"), ("oct", "eki"), ("nov", "kas"),
     ("dec", "ara")), 1) for name in names}
HTML_CELL = re.compile(r'mdl-typography--title">(.*?)<br>.*?mdl-typography--body-1">(.*?)</div>',
                       re.S)
HTML_LINK = re.compile(r'<a href="([^"]*)">(.*?)</a>', re.S)

VIDEO_NOISE = re.compile(
    r"\s*[\(\[\{][^\)\]\}]*\b(?:official|lyrics?|audio|video|visuali[sz]er|hd|hq|4k|m/?v|"
    r"clip|klip|live|performance)\b[^\)\]\}]*[\)\]\}]",
    re.IGNORECASE,
)
CHANNEL_NOISE = re.compile(r"\s*(?:vevo|official|official channel|music)$", re.IGNORECASE)


# --------------------------------------------------------------------------- import

def takeout_dir(data_dir: Path) -> Path:
    d = data_dir / "takeout"
    (d / "playlists").mkdir(parents=True, exist_ok=True)
    return d


def _keep(name: str):
    """Where a Takeout member should be stored, or None to skip it."""
    low = unicodedata.normalize("NFC", name.replace("\\", "/").lower())
    parts = low.split("/")
    if "__macosx" in parts or parts[-1].startswith("._"):
        return None                         # macOS resource forks from a re-zipped export
    if any(h in parts[-1] for h in HISTORY_NAMES):
        if low.endswith(".json"):
            return "history"
        if low.endswith(".html"):
            return "html"
    if "/playlists/" in "/" + low and (low.endswith(".csv") or low.endswith(".json")):
        return "playlist"
    stem = re.sub(r"\s*\(\d+\)$", "", parts[-1][:-4])      # "yorumlar(1).csv" continues yorumlar.csv
    if low.endswith(".csv") and not any(p in NOT_PLAYLISTS for p in parts[:-1] + [stem]):
        return "playlist"   # a CSV uploaded on its own, or a playlist in a translated folder
    return None


def save_upload(files, data_dir: Path):
    """Store watch history and playlist files from uploaded zips / JSON / CSV."""
    out = takeout_dir(data_dir)
    shutil.rmtree(out)
    out = takeout_dir(data_dir)
    counter = Counter()
    saw_html = False

    def store(kind, name, read):
        nonlocal saw_html
        if kind == "html":
            entries = parse_html_history(read().decode("utf-8", errors="replace"))
            if not entries:
                saw_html = True     # dates in a format we can't read: ask for JSON
                return
            kind, read = "history", lambda: json.dumps(entries).encode("utf-8")
        if kind == "history":
            counter["history"] += 1
            target = out / f"watch-history-{counter['history']}.json"
        else:
            target = out / "playlists" / os.path.basename(name.replace("\\", "/"))
        target.write_bytes(read())

    for f in files:
        name = f.filename or ""
        if name.lower().endswith(".zip"):
            with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
                f.save(tmp)
                tmp_path = tmp.name
            try:
                with zipfile.ZipFile(tmp_path) as z:
                    for member in z.namelist():
                        kind = _keep(member)
                        if kind:
                            store(kind, member, lambda m=member: z.read(m))
            finally:
                os.unlink(tmp_path)
        else:
            kind = _keep(name)
            if kind:
                data = f.read()
                store(kind, name, lambda d=data: d)

    return scan(data_dir, saw_html=saw_html)


# --------------------------------------------------------------------------- parsing

def parse_ts(text):
    text = (text or "").strip()
    if not text or len(text) < 10 or not text[:4].isdigit():
        return None
    text = text.replace(" UTC", "+00:00")
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def parse_html_time(text):
    text = re.sub(r"\s+", " ", text).replace("−", "-").replace("–", "-")
    m = HTML_TIME.search(text)
    if not m:
        return None
    day, name = (m[1], m[2]) if m[1] else (m[4], m[3])
    month = MONTHS.get(name.casefold()[:3])
    if not month:
        return None
    hour = int(m[6])
    if m[9]:
        hour = hour % 12 + (12 if m[9].upper() == "PM" else 0)
    sign, hh, mm = re.fullmatch(r"([+-])(\d{1,2}):?(\d{2})?", m[10]).groups() if m[10] else ("+", "0", "0")
    offset = timedelta(hours=int(hh), minutes=int(mm or 0)) * (-1 if sign == "-" else 1)
    try:
        local = datetime(int(m[5]), month, int(day), hour, int(m[7]), int(m[8]), tzinfo=timezone(offset))
    except ValueError:
        return None
    return local.astimezone(timezone.utc)


def _text(fragment):
    """The visible text of an HTML fragment."""
    return html.unescape(re.sub(r"<[^>]*>", "", fragment)).strip()


def parse_html_history(text):
    """Takeout's HTML watch history as the entries its JSON version would hold, or []
    if a YouTube Music play has a date we can't read: a history with silent gaps would mislead."""
    entries = []
    for cell in text.split('<div class="outer-cell')[1:]:
        m = HTML_CELL.search(cell)
        links = HTML_LINK.findall(m.group(2)) if m else []
        if not links or not URL_ID.search(links[0][0]):
            continue
        header = _text(m.group(1))
        segments = re.split(r"<br\s*/?>", m.group(2))
        first = next(i for i, s in enumerate(segments) if "<a " in s)
        # The title line (the video link inside its localized wrapper, as in JSON) comes first.
        # The date is the last later line that reads as one and has no link: the channel is a
        # link, and a date in a title or channel name must never stand in for a missing one.
        dates = [t for t in (_text(s) for s in segments[first + 1:] if "<a " not in s) if t]
        when = next((t for t in map(parse_html_time, reversed(dates)) if t), None)
        if when is None:
            if header == "YouTube Music" or "music.youtube.com" in links[0][0]:
                log.warning("HTML history has a date we can't read (%r); asking for JSON instead",
                            dates[-1][:80] if dates else "")
                return []
            continue            # plain YouTube: load_history drops it anyway
        entry = {"header": header,
                 "title": _text(segments[first]),
                 "titleUrl": html.unescape(links[0][0]),
                 "time": when.isoformat().replace("+00:00", "Z")}
        if len(links) > 1:
            entry["subtitles"] = [{"name": html.unescape(links[1][1]).strip(),
                                   "url": html.unescape(links[1][0])}]
        entries.append(entry)
    return entries


def load_history(folder: Path):
    """YouTube Music plays only: [{vid, time (datetime), title, channel}] oldest first."""
    seen, events = set(), []
    for path in sorted(folder.glob("watch-history*.json")):
        try:
            entries = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            log.warning("Skipping unreadable %s: %s", path.name, exc)
            continue
        for e in entries:
            url = e.get("titleUrl") or ""
            if e.get("header") != "YouTube Music" and "music.youtube.com" not in url:
                continue
            m, when = URL_ID.search(url), parse_ts(e.get("time"))
            # Whole seconds: HTML history has no milliseconds, so a JSON copy still matches.
            if not m or not when or (m.group(1), int(when.timestamp())) in seen:
                continue
            seen.add((m.group(1), int(when.timestamp())))
            subs = e.get("subtitles") or [{}]
            # HTML puts a no-break space between "Watched" and the title; JSON a plain one.
            events.append({"vid": m.group(1), "time": when, "title": e.get("title", "").replace("\xa0", " "),
                           "channel": subs[0].get("name", "")})
    events.sort(key=lambda ev: ev["time"])
    return events


def learn_affixes(titles):
    """Takeout wraps titles in localized text ("Watched X"). Learn it from the data."""
    sample = [t for t in titles if t and "://" not in t][:4000]
    if len(sample) < 10:
        hits = {w: sum(t.startswith(w[0]) and t.endswith(w[1]) for t in sample) for w in WATCH_WRAPPERS}
        best = max(WATCH_WRAPPERS, key=lambda w: (hits[w], len(w[0]) + len(w[1])))   # ties: longer wins
        return best if hits[best] else ("", "")
    prefix = os.path.commonprefix(sample)
    if " " in prefix:
        prefix = prefix[: prefix.rfind(" ") + 1]
    suffix = os.path.commonprefix([t[::-1] for t in sample])[::-1]
    if " " in suffix:
        suffix = suffix[suffix.find(" "):]
    # A couple of shared letters is coincidence, not wrapper text.
    if len(prefix.strip()) < 3:
        prefix = ""
    if len(suffix.strip()) < 3:
        suffix = ""
    return prefix, suffix


def learn_topic_suffix(channels):
    """Auto-generated artist channels are named "Artist - Topic" (the word may be localized)."""
    tails = Counter(c.rsplit(" - ", 1)[1] for c in channels if " - " in c)
    if tails:
        word, n = tails.most_common(1)[0]
        if n >= max(3, 0.2 * len(channels)):
            return " - " + word
    return " - Topic"


def is_video_id(cell):
    """11 URL-safe characters, but not an ordinary word like a CSV header ("Description")."""
    if not VIDEO_ID.match(cell):
        return False
    return not (cell.isalpha() and (cell.istitle() or cell.islower() or cell.isupper()))


def read_playlist(path: Path):
    """[(video_id, datetime|None, title|None)] from either CSV layout or legacy likes.json."""
    rows = []
    if path.suffix.lower() == ".json":
        try:
            items = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return rows
        for it in items if isinstance(items, list) else []:
            sn, cd = it.get("snippet", {}), it.get("contentDetails", {})
            vid = cd.get("videoId") or (sn.get("resourceId") or {}).get("videoId")
            if vid:
                rows.append((vid, parse_ts(sn.get("publishedAt")), sn.get("title")))
        return rows

    try:
        with open(path, encoding="utf-8-sig", newline="") as fh:
            for row in csv.reader(fh):
                cells = [c.strip() for c in row]
                vid = next((c for c in cells if is_video_id(c)), None)
                if not vid:
                    continue
                when = next((t for t in (parse_ts(c) for c in cells if c != vid) if t), None)
                rows.append((vid, when, None))
    except (UnicodeDecodeError, csv.Error) as exc:   # e.g. re-saved by Excel in a local code page
        log.warning("Skipping unreadable %s: %s", path.name, exc)
        return []
    return rows


def cached_scan(data_dir: Path):
    path = takeout_dir(data_dir) / "scan.json"
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return scan(data_dir)


def likes_choice(data_dir: Path, new=None):
    """Remember which playlist file holds the likes, so a rebuild reuses it."""
    path = takeout_dir(data_dir) / "options.json"
    if new is not None:
        path.write_text(json.dumps({"likes_file": new}), encoding="utf-8")
        return new
    try:
        return json.loads(path.read_text(encoding="utf-8")).get("likes_file")
    except (OSError, json.JSONDecodeError):
        return None


def scan(data_dir: Path, saw_html=False):
    folder = takeout_dir(data_dir)
    events = load_history(folder)
    playlists = []
    for p in sorted((folder / "playlists").glob("*")):
        rows = read_playlist(p)
        if rows:
            dated = sum(1 for r in rows if r[1])
            playlists.append({"file": p.name, "rows": len(rows), "dated": dated,
                              "likely_likes": any(h in p.name.lower() for h in LIKES_HINTS)})
    result = {
        "plays": len(events),
        "songs": len({e["vid"] for e in events}),
        "first": events[0]["time"].isoformat() if events else None,
        "last": events[-1]["time"].isoformat() if events else None,
        "playlists": playlists,
        "html_history": saw_html and not events,
        "has_files": bool(events or playlists),
    }
    (folder / "scan.json").write_text(json.dumps(result), encoding="utf-8")
    return result


# --------------------------------------------------------------------------- names & matching

def norm(text):
    text = (text or "").casefold().replace("ı", "i")
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"[\(\[\{].*?[\)\]\}]", " ", text)
    text = re.sub(r"\b(?:feat|ft|featuring)\b.*$", " ", text)
    text = re.sub(r"[^\w\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def title_artist(raw_title, channel, affixes, topic_suffix):
    prefix, suffix = affixes
    title = raw_title
    if prefix and title.startswith(prefix):
        title = title[len(prefix):]
    if suffix and title.endswith(suffix):
        title = title[: -len(suffix)]
    title = title.strip()
    if not title or "://" in title:
        return None, None, False

    is_topic = channel.endswith(topic_suffix)
    artist = channel[: -len(topic_suffix)].strip() if is_topic else channel
    if not is_topic and " - " in title:        # "Artist - Song (Official Video)"
        artist, title = [x.strip() for x in title.split(" - ", 1)]
    artist = CHANNEL_NOISE.sub("", artist).strip()
    title = VIDEO_NOISE.sub("", title)
    title = re.sub(r"\s*\|.*$", "", title)
    title = sources.clean_title(title).strip()
    return title, artist, is_topic


def oembed(vid, cache: sources.Cache):
    hit = cache.get("youtube_meta", vid)
    if hit is not None:
        return None if "miss" in hit else hit
    try:
        r = sources.HTTP.get(OEMBED_URL, timeout=15, params={
            "url": f"https://www.youtube.com/watch?v={vid}", "format": "json"})
        data = r.json() if r.status_code == 200 else None
    except (requests.RequestException, ValueError):
        data = None
    time.sleep(0.15)
    if not data:
        cache.put("youtube_meta", vid, {"miss": time.time()})
        return None
    meta = {"title": data.get("title", ""), "author": data.get("author_name", "")}
    cache.put("youtube_meta", vid, meta)
    return meta


def _similarity(a, b):
    a, b = norm(a), norm(b)
    return SequenceMatcher(None, a, b).ratio() if a and b else 0.0


def match_spotify(sp, song, cache: sources.Cache):
    """Best Spotify track for a YouTube song: {'id', 'score'} (id None if nothing good)."""
    key = song["id"]
    hit = cache.get("spotify_match", key)
    if hit is not None:
        return hit

    title, artist = song["name"], song["artists"][0] if song["artists"] else ""
    best = {"id": None, "score": 0.0}
    for q in (f"track:{title} artist:{artist}", f"{title} {artist}"):
        try:
            items = sp.search(q=q, type="track", limit=5).get("tracks", {}).get("items", [])
        except Exception as exc:  # spotipy raises its own exception types
            log.warning("Spotify search failed for %r: %s", q, exc)
            items = []
        for it in items:
            t_sim = _similarity(title, it.get("name", ""))
            a_sim = max((_similarity(artist, a.get("name", "")) for a in it.get("artists", [])),
                        default=0.0)
            score = 0.55 * t_sim + 0.45 * a_sim
            if score > best["score"]:
                best = {"id": it.get("id"), "score": round(score, 3),
                        "name": it.get("name"), "artist": ", ".join(a.get("name", "") for a in it.get("artists", []))}
        if best["score"] >= MATCH_THRESHOLD:
            break
        time.sleep(0.05)

    if best["score"] < MATCH_THRESHOLD:
        best["id"] = None
    cache.put("spotify_match", key, best)
    return best


# --------------------------------------------------------------------------- pipeline

def build_youtube(likes_file, sp, lastfm_key, data_dir: Path, progress):
    """likes_file: playlist file name, "" for none, or None to reuse the last choice."""
    folder = takeout_dir(data_dir)
    likes_file = likes_choice(data_dir) if likes_file is None else likes_choice(data_dir, likes_file)
    cache = sources.Cache(data_dir / "mood_cache.json")

    progress("Reading your YouTube Music history", 0, 1)
    events = load_history(folder)
    affixes = learn_affixes([e["title"] for e in events])
    topic_suffix = learn_topic_suffix([e["channel"] for e in events])
    log.info("History: %d plays, title affixes %r, topic suffix %r", len(events), affixes, topic_suffix)

    songs, by_key, by_vid = [], {}, {}

    def song_for(vid, raw_title, channel):
        title, artist, is_topic = title_artist(raw_title, channel, affixes, topic_suffix)
        if not title:
            return None
        key = f"{norm(artist)}|{norm(title)}"
        if key not in by_key:
            by_key[key] = len(songs)
            songs.append({
                "id": key, "name": title, "artists": [artist] if artist else [], "album": "",
                "image": f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg",
                "image_large": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                "url": f"https://music.youtube.com/watch?v={vid}",
            })
        by_vid[vid] = by_key[key]
        return by_key[key]

    plays = []
    for ev in events:
        idx = by_vid.get(ev["vid"])
        if idx is None:
            idx = song_for(ev["vid"], ev["title"], ev["channel"])
        if idx is not None:
            plays.append([int(ev["time"].timestamp()), idx])

    likes, skipped = [], 0
    if likes_file:
        rows = read_playlist(folder / "playlists" / os.path.basename(likes_file))
        for n, (vid, when, title) in enumerate(rows, 1):
            idx = by_vid.get(vid)
            if idx is None:
                meta = oembed(vid, cache)
                # Only keep likes that are clearly songs: an auto-generated artist channel.
                if meta and meta["author"].endswith(topic_suffix):
                    idx = song_for(vid, affixes[0] + meta["title"] + affixes[1], meta["author"])
            if idx is None or when is None:
                skipped += 1
            else:
                likes.append([idx, when.isoformat().replace("+00:00", "Z")])
            if n % 20 == 0 or n == len(rows):
                progress("Reading liked songs", n, len(rows))
        likes.sort(key=lambda r: r[1])
        cache.save()

    if sp is not None:
        for n, s in enumerate(songs, 1):
            m = match_spotify(sp, s, cache)
            s["spotify_id"], s["match"] = m.get("id"), m.get("score")
            if n % 25 == 0 or n == len(songs):
                progress("Matching songs to Spotify", n, len(songs))
                cache.save()

    sources.attach_moods(songs, cache, lastfm_key, progress)
    cache.save()

    return {
        "provider": "youtube",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "lastfm_enabled": bool(lastfm_key),
        "spotify_matching": sp is not None,
        "songs": songs,
        "likes": likes,
        "plays": plays,
        "skipped_likes": skipped,
    }
