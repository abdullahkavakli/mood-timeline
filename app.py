"""
Mood timeline for your Spotify and YouTube Music songs.

    python app.py          # real data (needs .env for Spotify)
    python app.py --demo   # synthetic libraries, no accounts needed

Then open http://127.0.0.1:8888 (use 127.0.0.1, not localhost: Spotify only
accepts loopback IP redirect URIs).
"""

import argparse
import json
import logging
import os
import random
import threading
import traceback
import webbrowser
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, render_template, request

import sources
import youtube

ROOT = Path(__file__).parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
TOKEN_FILE = DATA_DIR / ".spotify-token"
PROVIDERS = ("spotify", "youtube")

load_dotenv(ROOT / ".env")
HOST = "127.0.0.1"
PORT = int(os.getenv("PORT", "8888"))
REDIRECT_URI = os.getenv("SPOTIFY_REDIRECT_URI", f"http://{HOST}:{PORT}/callback")
SCOPE = "user-library-read"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s: %(message)s")
log = logging.getLogger("app")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 1024 * 1024 * 1024   # Takeout zips can be large
DEMO = False


def data_file(provider):
    return DATA_DIR / (f"demo-{provider}.json" if DEMO else f"{provider}.json")


# --------------------------------------------------------------------------- spotify auth

def spotify_configured():
    return bool(os.getenv("SPOTIFY_CLIENT_ID") and os.getenv("SPOTIFY_CLIENT_SECRET"))


def auth_manager():
    from spotipy.cache_handler import CacheFileHandler
    from spotipy.oauth2 import SpotifyOAuth

    if not spotify_configured():
        return None
    return SpotifyOAuth(
        client_id=os.getenv("SPOTIFY_CLIENT_ID"), client_secret=os.getenv("SPOTIFY_CLIENT_SECRET"),
        redirect_uri=REDIRECT_URI, scope=SCOPE, open_browser=False,
        cache_handler=CacheFileHandler(cache_path=str(TOKEN_FILE)),
    )


def spotify_client():
    import spotipy
    am = auth_manager()
    if am and am.validate_token(am.cache_handler.get_cached_token()):
        return spotipy.Spotify(auth_manager=am, retries=3, status_retries=3)
    return None


# --------------------------------------------------------------------------- job

class Job:
    def __init__(self):
        self.lock = threading.Lock()
        self.state = {"status": "idle", "provider": None, "step": "", "done": 0, "total": 0,
                      "error": None}

    def update(self, **kw):
        with self.lock:
            self.state.update(kw)

    def snapshot(self):
        with self.lock:
            return dict(self.state)


JOB = Job()


def run_build(provider, likes_file=None):
    progress = lambda step, done, total: JOB.update(step=step, done=done, total=total)
    try:
        JOB.update(status="running", provider=provider, step="Starting", done=0, total=0, error=None)
        if DEMO:
            result = demo_spotify() if provider == "spotify" else demo_youtube()
        elif provider == "spotify":
            sp = spotify_client()
            if sp is None:
                raise RuntimeError("Spotify session expired. Connect Spotify again.")
            result = sources.build_spotify(sp, os.getenv("LASTFM_API_KEY"), DATA_DIR, progress)
        else:
            sp = spotify_client()   # optional: only used to match songs for mood lookup
            result = youtube.build_youtube(likes_file, sp, os.getenv("LASTFM_API_KEY"),
                                           DATA_DIR, progress)
        data_file(provider).write_text(json.dumps(result), encoding="utf-8")
        JOB.update(status="done", step="Finished")
    except Exception as exc:  # surface everything to the page
        log.error("Build failed:\n%s", traceback.format_exc())
        JOB.update(status="error", error=str(exc) or exc.__class__.__name__)


# --------------------------------------------------------------------------- routes

@app.get("/")
def index():
    return render_template("index.html")


@app.get("/login")
def login():
    am = auth_manager()
    return redirect(am.get_authorize_url() if am else "/")


@app.get("/callback")
def callback():
    am = auth_manager()
    if request.args.get("error") or am is None:
        return redirect("/?auth_error=" + request.args.get("error", "missing_credentials"))
    am.get_access_token(request.args["code"], as_dict=False, check_cache=False)
    return redirect("/?provider=spotify")


@app.post("/api/logout")
def logout():
    TOKEN_FILE.unlink(missing_ok=True)
    return jsonify(ok=True)


@app.get("/api/status")
def status():
    authed = DEMO or (spotify_configured() and spotify_client() is not None)
    return jsonify(
        demo=DEMO,
        has_lastfm=DEMO or bool(os.getenv("LASTFM_API_KEY")),
        job=JOB.snapshot(),
        spotify={"configured": DEMO or spotify_configured(), "authenticated": authed,
                 "has_data": data_file("spotify").exists(), "redirect_uri": REDIRECT_URI},
        youtube={"has_data": data_file("youtube").exists(),
                 "takeout": {"has_files": True, "plays": 1, "songs": 1, "playlists": []} if DEMO
                 else youtube.cached_scan(DATA_DIR),
                 "spotify_matching": authed},
    )


@app.post("/api/youtube/upload")
def youtube_upload():
    files = request.files.getlist("files")
    if not files:
        return jsonify(error="No files received"), 400
    return jsonify(youtube.save_upload(files, DATA_DIR))


@app.post("/api/build")
def build():
    body = request.get_json(silent=True) or {}
    provider = body.get("provider")
    if provider not in PROVIDERS:
        return jsonify(error="Unknown provider"), 400
    if JOB.snapshot()["status"] == "running":
        return jsonify(ok=True, already_running=True)
    threading.Thread(target=run_build, args=(provider, body.get("likes_file")), daemon=True).start()
    return jsonify(ok=True)


@app.get("/api/data/<provider>")
def data(provider):
    path = data_file(provider) if provider in PROVIDERS else None
    if not path or not path.exists():
        return jsonify(error="No data yet"), 404
    return app.response_class(path.read_text(encoding="utf-8"), mimetype="application/json")


# --------------------------------------------------------------------------- demo data

MOODS = {"happy": (0.82, 0.78), "calm": (0.70, 0.25), "sad": (0.16, 0.24), "tense": (0.20, 0.85)}
WORDS = {
    "happy": ["Sunlit", "Neon", "Golden", "Carousel", "Jump", "Fever"],
    "calm": ["Driftwood", "Linen", "Harbour", "Slow", "Moss", "Porch"],
    "sad": ["Empty", "Rain", "Letters", "Grey", "Winter", "Leaving"],
    "tense": ["Static", "Wire", "Riot", "Engine", "Teeth", "Voltage"],
}


def _demo_song(rng, n, mood, noisy=0.18):
    cv, ce = MOODS[mood]
    wild = rng.random() < noisy
    v = rng.random() if wild else min(1, max(0, rng.gauss(cv, 0.09)))
    e = rng.random() if wild else min(1, max(0, rng.gauss(ce, 0.09)))
    src = rng.choices(["reccobeats", "lastfm-track", "lastfm-artist", None], [0.8, 0.1, 0.04, 0.06])[0]
    return {
        "id": f"demo{n}", "mood": mood,
        "name": f"{rng.choice(WORDS[mood])} {rng.choice(['Song', 'Hours', 'Lines', 'Room', 'Signal'])}",
        "artists": [f"Demo Artist {rng.randint(1, 60)}"], "album": "Demo album",
        "image": None, "image_large": None, "url": None,
        "valence": None if src is None else round(v, 3),
        "energy": None if src is None else round(e, 3),
        "source": src, "confidence": 1.0 if src == "reccobeats" else 0.5,
        "tags": [] if src in (None, "reccobeats") else [mood],
        "match": round(rng.uniform(0.78, 1.0), 2),
    }


def demo_spotify():
    rng = random.Random(7)
    t = datetime.now(timezone.utc) - timedelta(days=730)
    songs, likes = [], []
    while t < datetime.now(timezone.utc):
        mood = rng.choice(list(MOODS))
        for _ in range(rng.randint(3, 9)):
            songs.append(_demo_song(rng, len(songs), mood))
            likes.append([len(songs) - 1, t.strftime("%Y-%m-%dT%H:%M:%SZ")])
            t += timedelta(hours=rng.uniform(0.2, 20))
        t += timedelta(days=rng.expovariate(1 / 9))
    return {"provider": "spotify", "generated_at": datetime.now(timezone.utc).isoformat(),
            "lastfm_enabled": True, "songs": songs, "likes": likes, "plays": []}


def demo_youtube():
    """Daily listening that drifts between mood phases, with favourites on repeat."""
    rng = random.Random(11)
    pools = {m: [] for m in MOODS}
    songs, likes, plays = [], [], []
    liked = set()
    day = datetime.now(timezone.utc) - timedelta(days=540)
    mood, phase_left = "calm", 10
    while day < datetime.now(timezone.utc):
        if phase_left <= 0:
            mood, phase_left = rng.choice(list(MOODS)), rng.randint(5, 20)
        phase_left -= 1
        pool = pools[mood]
        if len(pool) < 25 or rng.random() < 0.3:
            for _ in range(rng.randint(1, 3)):
                songs.append(_demo_song(rng, len(songs), mood))
                pool.append(len(songs) - 1)
        t = day + timedelta(hours=rng.uniform(8, 20))
        for _ in range(rng.randint(0, 30)):
            k = min(len(pool) - 1, int(rng.paretovariate(1.2)) - 1)   # favourites repeat
            idx = pool[-1 - k] if rng.random() < 0.7 else rng.choice(pool)
            plays.append([int(t.timestamp()), idx])
            if idx not in liked and rng.random() < 0.08:
                liked.add(idx)
                likes.append([idx, t.strftime("%Y-%m-%dT%H:%M:%SZ")])
            t += timedelta(minutes=rng.uniform(2.5, 5))
        day += timedelta(days=1)
    for s in songs:
        s.pop("mood", None)
    JOB.update(step="Building demo library", done=len(plays), total=len(plays))
    return {"provider": "youtube", "generated_at": datetime.now(timezone.utc).isoformat(),
            "lastfm_enabled": True, "spotify_matching": True, "songs": songs,
            "likes": likes, "plays": plays, "skipped_likes": 0}


# --------------------------------------------------------------------------- main

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--demo", action="store_true", help="use synthetic libraries")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    DEMO = args.demo

    url = f"http://{HOST}:{PORT}"
    log.info("Mood timeline running at %s", url)
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host=HOST, port=PORT, debug=False)
