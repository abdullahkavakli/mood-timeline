"""
Turn Last.fm tags into a (valence, energy) point.

Both values are 0..1 to match ReccoBeats / old Spotify audio features:
  valence 0 = sad / negative,   1 = happy / positive
  energy  0 = calm / low,       1 = energetic / intense

Coordinates follow Russell's circumplex model of affect: every mood word sits
somewhere on the valence x arousal plane. Explicit mood tags carry full weight;
genre tags only nudge the estimate because a genre says less about mood.
"""

import re

# (valence, energy)
MOOD_TAGS = {
    # happy, energetic
    "happy": (0.90, 0.65), "happiness": (0.90, 0.65), "joyful": (0.92, 0.70),
    "joy": (0.92, 0.70), "cheerful": (0.90, 0.65), "upbeat": (0.85, 0.80),
    "fun": (0.85, 0.75), "feel good": (0.88, 0.65), "feelgood": (0.88, 0.65),
    "good vibes": (0.85, 0.60), "party": (0.80, 0.90), "dance": (0.75, 0.85),
    "danceable": (0.75, 0.85), "energetic": (0.65, 0.92), "energy": (0.65, 0.90),
    "euphoric": (0.90, 0.90), "euphoria": (0.90, 0.90), "uplifting": (0.85, 0.70),
    "summer": (0.80, 0.70), "sunny": (0.85, 0.65), "catchy": (0.72, 0.65),
    "groovy": (0.75, 0.70), "hype": (0.70, 0.95), "motivational": (0.75, 0.85),
    "motivation": (0.75, 0.85), "workout": (0.65, 0.92), "gym": (0.60, 0.93),
    "optimistic": (0.85, 0.60), "playful": (0.85, 0.65), "exciting": (0.75, 0.88),
    "triumphant": (0.80, 0.85), "epic": (0.60, 0.85), "anthem": (0.70, 0.85),
    "sexy": (0.70, 0.55), "love": (0.75, 0.45), "love songs": (0.72, 0.40),
    "romantic": (0.72, 0.35), "sweet": (0.80, 0.40), "cute": (0.85, 0.50),
    "hopeful": (0.72, 0.45), "confident": (0.75, 0.75), "badass": (0.60, 0.88),

    # calm, content
    "chill": (0.62, 0.25), "chillout": (0.62, 0.22), "chill out": (0.62, 0.22),
    "relaxing": (0.65, 0.15), "relax": (0.65, 0.15), "calm": (0.60, 0.12),
    "peaceful": (0.70, 0.10), "mellow": (0.55, 0.25), "soothing": (0.65, 0.12),
    "dreamy": (0.62, 0.25), "warm": (0.72, 0.35), "easy listening": (0.65, 0.30),
    "laid back": (0.65, 0.30), "laidback": (0.65, 0.30), "smooth": (0.65, 0.35),
    "serene": (0.70, 0.10), "tender": (0.65, 0.20), "beautiful": (0.65, 0.35),
    "sleep": (0.50, 0.05), "lullaby": (0.60, 0.05), "cozy": (0.72, 0.20),
    "ethereal": (0.55, 0.20), "atmospheric": (0.45, 0.30),

    # sad, low
    "sad": (0.10, 0.25), "sadness": (0.10, 0.25), "sad songs": (0.10, 0.25),
    "melancholy": (0.20, 0.25), "melancholic": (0.20, 0.25), "melancholia": (0.20, 0.25),
    "depressing": (0.05, 0.20), "depressive": (0.05, 0.20), "depression": (0.05, 0.20),
    "heartbreak": (0.10, 0.35), "heartbroken": (0.10, 0.35), "broken heart": (0.10, 0.35),
    "lonely": (0.15, 0.20), "loneliness": (0.15, 0.20), "sorrow": (0.10, 0.20),
    "grief": (0.08, 0.20), "cry": (0.10, 0.30), "crying": (0.10, 0.30),
    "tearjerker": (0.12, 0.30), "gloomy": (0.15, 0.25), "somber": (0.15, 0.20),
    "bleak": (0.10, 0.30), "hopeless": (0.05, 0.25), "bittersweet": (0.40, 0.35),
    "nostalgic": (0.45, 0.35), "nostalgia": (0.45, 0.35), "longing": (0.30, 0.30),
    "wistful": (0.35, 0.25), "rainy day": (0.30, 0.20), "rain": (0.30, 0.20),
    "haunting": (0.25, 0.35), "moody": (0.30, 0.40), "introspective": (0.35, 0.25),
    "reflective": (0.40, 0.25), "emotional": (0.30, 0.45), "breakup": (0.15, 0.45),
    "sad rap": (0.15, 0.50), "ballad": (0.40, 0.25), "slow": (0.45, 0.15),

    # tense, angry
    "angry": (0.12, 0.90), "anger": (0.12, 0.90), "rage": (0.10, 0.95),
    "aggressive": (0.18, 0.95), "angst": (0.20, 0.75), "angsty": (0.20, 0.75),
    "intense": (0.35, 0.90), "tense": (0.25, 0.75), "anxious": (0.20, 0.70),
    "anxiety": (0.20, 0.70), "dark": (0.20, 0.55), "brutal": (0.15, 0.97),
    "hate": (0.10, 0.85), "revenge": (0.20, 0.80), "chaotic": (0.30, 0.90),
    "frantic": (0.35, 0.90), "dramatic": (0.35, 0.70), "ominous": (0.20, 0.55),
    "creepy": (0.20, 0.50), "bitter": (0.20, 0.55), "heavy": (0.30, 0.90),

    # Turkish mood words that show up in Last.fm tags
    "hüzünlü": (0.12, 0.25), "huzunlu": (0.12, 0.25), "hüzün": (0.12, 0.25),
    "duygusal": (0.30, 0.40), "melankolik": (0.20, 0.25), "mutlu": (0.90, 0.65),
    "neşeli": (0.90, 0.70), "hareketli": (0.80, 0.85), "sakin": (0.60, 0.15),
    "damar": (0.08, 0.35), "arabesk": (0.15, 0.40),
}

GENRE_TAGS = {
    "metal": (0.30, 0.92), "heavy metal": (0.35, 0.92), "death metal": (0.15, 0.97),
    "black metal": (0.12, 0.95), "metalcore": (0.25, 0.95), "hardcore": (0.25, 0.95),
    "punk": (0.50, 0.90), "pop punk": (0.60, 0.85), "emo": (0.25, 0.70),
    "hard rock": (0.50, 0.85), "rock": (0.50, 0.70), "alternative rock": (0.45, 0.70),
    "grunge": (0.30, 0.75), "edm": (0.70, 0.90), "house": (0.70, 0.80),
    "techno": (0.55, 0.85), "trance": (0.65, 0.80), "drum and bass": (0.55, 0.90),
    "dubstep": (0.45, 0.92), "disco": (0.85, 0.80), "funk": (0.80, 0.75),
    "reggae": (0.75, 0.45), "ska": (0.80, 0.80), "pop": (0.70, 0.65),
    "dance pop": (0.78, 0.78), "k-pop": (0.75, 0.75), "hip hop": (0.55, 0.70),
    "hip-hop": (0.55, 0.70), "rap": (0.50, 0.75), "trap": (0.40, 0.80),
    "drill": (0.30, 0.80), "rnb": (0.60, 0.45), "r&b": (0.60, 0.45),
    "soul": (0.60, 0.45), "jazz": (0.60, 0.35), "smooth jazz": (0.65, 0.25),
    "blues": (0.35, 0.40), "folk": (0.50, 0.30), "acoustic": (0.50, 0.25),
    "singer-songwriter": (0.45, 0.30), "indie folk": (0.45, 0.30),
    "ambient": (0.50, 0.12), "classical": (0.50, 0.30), "piano": (0.45, 0.20),
    "lo-fi": (0.55, 0.20), "lofi": (0.55, 0.20), "shoegaze": (0.40, 0.45),
    "dream pop": (0.55, 0.30), "post-rock": (0.40, 0.50), "doom": (0.10, 0.60),
    "gothic": (0.20, 0.50), "darkwave": (0.25, 0.60), "synthwave": (0.60, 0.70),
    "anatolian rock": (0.55, 0.65), "turkish pop": (0.70, 0.65),
}

GENRE_WEIGHT = 0.35   # genre tags count about a third as much as mood tags
MIN_TAG_COUNT = 5     # Last.fm tag counts are 0-100 relative to the top tag


def normalize_tag(name: str) -> str:
    name = name.lower().strip().replace("_", " ")
    name = re.sub(r"\s+", " ", name)
    return name


def score_tags(tags):
    """
    tags: list of {"name": str, "count": int} from Last.fm (count 0-100).
    Returns dict(valence, energy, confidence, matched) or None.
    """
    total_w = v_sum = e_sum = 0.0
    matched = []
    has_mood_tag = False

    for tag in tags:
        try:
            count = float(tag.get("count", 0))
        except (TypeError, ValueError):
            count = 0.0
        if count < MIN_TAG_COUNT:
            continue
        key = normalize_tag(tag.get("name", ""))
        if key in MOOD_TAGS:
            (v, e), kind_w = MOOD_TAGS[key], 1.0
            has_mood_tag = True
        elif key in GENRE_TAGS:
            (v, e), kind_w = GENRE_TAGS[key], GENRE_WEIGHT
        else:
            continue
        w = (count / 100.0) * kind_w
        total_w += w
        v_sum += w * v
        e_sum += w * e
        matched.append(key)

    if total_w == 0:
        return None

    valence = v_sum / total_w
    energy = e_sum / total_w

    # Confidence grows with matched tag weight; genre-only guesses stay low.
    confidence = min(1.0, total_w / 1.2)
    if not has_mood_tag:
        confidence = min(confidence, 0.35)

    # Pull weak guesses toward the neutral centre so they don't fake clusters.
    shrink = 0.5 + 0.5 * confidence
    valence = 0.5 + (valence - 0.5) * shrink
    energy = 0.5 + (energy - 0.5) * shrink

    return {
        "valence": round(valence, 4),
        "energy": round(energy, 4),
        "confidence": round(confidence, 3),
        "matched": matched[:6],
        "has_mood_tag": has_mood_tag,
    }
