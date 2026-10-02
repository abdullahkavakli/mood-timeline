"use strict";

/* Mood zones on the circumplex: valence (sad..happy) x energy (calm..energetic).
   Values arrive as 0..1 and are centred to -1..1 so the neutral point sits at zero. */
const ZONES = {
  bright:  { label: "Happy, energetic", short: "Upbeat",  word: "upbeat",  color: "#f0a020" },
  calm:    { label: "Content, calm",    short: "Calm",    word: "calm",    color: "#2e9e78" },
  low:     { label: "Sad, low",         short: "Sad",     word: "sad",     color: "#3d6bd6" },
  tense:   { label: "Tense, angry",     short: "Tense",   word: "tense",   color: "#d4405a" },
  neutral: { label: "In between",       short: "Neutral", word: "neutral", color: "#9aa1b0" },
};
const STREAK_ZONES = ["bright", "calm", "low", "tense"];
const NEUTRAL_RADIUS = 0.18;
const DIM = "#c9ced8";
const INK = "#1e2230";
const SYMBOL = { reccobeats: "circle", "lastfm-track": "diamond", "lastfm-artist": "square" };
const PROVIDER_NAME = { spotify: "Spotify", youtube: "YouTube Music" };
const MAX_RINGS = 900, RING_SIDES = 16;
const MIN_NEFF = 4;          // fewer effective songs than this: no band for that stretch
const MAX_SEMI_AXIS = 1.1;   // a region wider than the chart says nothing; leave a gap

const PREF_KEYS = ["provider", "view", "group", "weighting", "band", "level", "axis", "sweepSize"];
const S = {
  status: null, data: {}, provider: "spotify", view: "liked",
  axis: "date", group: "day", weighting: true, band: true, level: 95,
  minLen: 4, tolerance: 1, smooth: 7, showUnplaced: false,
  sweepOn: false, sweepStart: 0, sweepSize: 300,
  items: [], pts: [], unplaced: [], streaks: [], zone: null, streak: null, plotted: false,
};

const $ = (id) => document.getElementById(id);
const fmtDay = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const fmtMonth = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" });
const fmtFull = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const num = (n) => n.toLocaleString();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;
/* Plotly draws a date string's wall-clock time as written, so give it local time, like the labels. */
const localIso = (d) => new Date(+d - d.getTimezoneOffset() * 60000).toISOString().slice(0, -1);

function savePrefs() {
  try { localStorage.setItem("mood-prefs", JSON.stringify(Object.fromEntries(PREF_KEYS.map((k) => [k, S[k]])))); }
  catch { /* storage may be unavailable */ }
}
function loadPrefs() {
  try { Object.assign(S, JSON.parse(localStorage.getItem("mood-prefs") || "{}")); }
  catch { /* ignore */ }
  if (!SWEEP_SIZES.includes(S.sweepSize)) S.sweepSize = 300;
}

/* ------------------------------------------------------------------ mood maths */

function zoneOf(v, e) {
  if (Math.hypot(v, e) < NEUTRAL_RADIUS) return "neutral";
  if (v >= 0) return e >= 0 ? "bright" : "calm";
  return e >= 0 ? "tense" : "low";
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const CORNERS = { low: hex(ZONES.low.color), tense: hex(ZONES.tense.color),
                  calm: hex(ZONES.calm.color), bright: hex(ZONES.bright.color) };

/* Blend the four corner colours by position, so colour itself reads as mood. */
function moodColor(v, e) {
  const push = (x) => 0.5 + 0.5 * Math.sign(x) * Math.pow(Math.abs(x), 0.6);
  const tv = push(v), te = push(e);
  const c = [0, 1, 2].map((k) =>
    (1 - tv) * (1 - te) * CORNERS.low[k] + (1 - tv) * te * CORNERS.tense[k] +
    tv * (1 - te) * CORNERS.calm[k] + tv * te * CORNERS.bright[k]);
  return `rgb(${c.map(Math.round).join(",")})`;
}

/* Runs of items (in time order) that stay in one zone, allowing up to
   `tolerance` off-mood items in a row inside the run. */
function findStreaks(pts, minLen, tolerance) {
  const out = [];
  for (const zone of STREAK_ZONES) {
    let run = null, miss = 0;
    const close = () => {
      if (run && run.members.length >= minLen) out.push(run);
      run = null; miss = 0;
    };
    pts.forEach((p, i) => {
      if (p.zone === zone) {
        if (!run) run = { zone, members: [] };
        run.members.push(i);
        miss = 0;
      } else if (run && ++miss > tolerance) {
        close();
      }
    });
    close();
  }
  return out.map((r) => {
    const start = r.members[0], end = r.members[r.members.length - 1];
    const plays = r.members.reduce((a, i) => a + pts[i].count, 0);
    return { ...r, start, end, count: r.members.length, plays, off: end - start + 1 - r.members.length,
             from: pts[start].date, to: pts[end].date };
  }).sort((a, b) => b.to - a.to);
}

/* Quantile of F(2, m): closed form because the numerator has 2 degrees of freedom. */
const fQuantile2 = (p, m) => (m / 2) * (Math.pow(1 - p, -2 / m) - 1);

/* Weighted mean mood in a centred window around each point, plus the Hotelling T²
   confidence region for that mean (an ellipse in the valence x energy plane).
   Weighted windows use Kish's effective sample size n_eff = (Σw)² / Σw². */
function trailStats(pts, window, level) {
  const half = Math.floor(window / 2), p = level / 100, out = [];
  for (let i = 0; i < pts.length; i++) {
    const lo = Math.max(0, i - half), hi = Math.min(pts.length - 1, i + half);
    let W = 0, W2 = 0, mv = 0, me = 0;
    for (let j = lo; j <= hi; j++) {
      const w = pts[j].w; W += w; W2 += w * w; mv += w * pts[j].v; me += w * pts[j].e;
    }
    mv /= W; me /= W;
    let a = 0, b = 0, c = 0;
    for (let j = lo; j <= hi; j++) {
      const w = pts[j].w, dv = pts[j].v - mv, de = pts[j].e - me;
      a += w * dv * dv; b += w * dv * de; c += w * de * de;
    }
    const nEff = (W * W) / W2, denom = W - W2 / W;
    const row = { v: mv, e: me, nEff, ok: false };
    if (nEff > 2.05 && denom > 1e-9) {
      a = a / denom + 1e-6; b /= denom; c = c / denom + 1e-6;
      const m = nEff - 2;
      const t2 = ((2 * (nEff - 1)) / m) * fQuantile2(p, m);
      const scale = Math.sqrt(t2 / nEff);
      const l11 = Math.sqrt(a), l21 = b / l11, l22 = Math.sqrt(Math.max(c - l21 * l21, 1e-9));
      const lamMax = (a + c) / 2 + Math.sqrt(((a - c) / 2) ** 2 + b * b);
      const semi = scale * Math.sqrt(lamMax);
      Object.assign(row, { ok: nEff >= MIN_NEFF && semi <= MAX_SEMI_AXIS, scale, l11, l21, l22 });
    }
    out.push(row);
  }
  return out;
}

/* ------------------------------------------------------------------ data */

function prepareDataset(data) {
  const plays = new Array(data.songs.length).fill(0);
  for (const [, idx] of data.plays) plays[idx]++;
  data.songs.forEach((s, i) => {
    s.plays = plays[i];
    if (s.valence != null) {
      s.v = 2 * s.valence - 1; s.e = 2 * s.energy - 1;
      s.zone = zoneOf(s.v, s.e); s.color = moodColor(s.v, s.e);
    }
  });
  data.hasPlays = data.plays.length > 0;
  return data;
}

function localDay(ms) {
  const d = new Date(ms);
  return Math.floor((ms - d.getTimezoneOffset() * 60000) / 864e5);
}

/* Liked needs likes: a history-only YouTube build has none, so it shows plays. */
const viewOf = (data) => (!data.hasPlays ? "liked" : data.likes.length ? S.view : "listened");

function buildItems() {
  const data = S.data[S.provider];
  let items;
  if (viewOf(data) === "liked") {
    items = data.likes.map(([idx, iso]) => ({
      song: data.songs[idx], date: new Date(iso), count: data.hasPlays ? data.songs[idx].plays : 1,
      kind: "like",
    }));
  } else if (S.group === "play") {
    items = data.plays.map(([t, idx]) => ({ song: data.songs[idx], date: new Date(t * 1000), count: 1, kind: "play" }));
  } else {
    const byKey = new Map();
    for (const [t, idx] of data.plays) {
      const day = localDay(t * 1000);
      const bucket = S.group === "week" ? Math.floor((day + 3) / 7) : day;   // weeks start Monday
      const key = `${bucket}:${idx}`;
      const hit = byKey.get(key);
      if (hit) hit.count++;
      else byKey.set(key, { song: data.songs[idx], date: new Date(t * 1000), count: 1, kind: S.group });
    }
    items = [...byKey.values()];
  }
  items.sort((a, b) => a.date - b.date);
  items.forEach((it, i) => {
    it.order = i;
    it.iso = localIso(it.date);
    Object.assign(it, { v: it.song.v, e: it.song.e, zone: it.song.zone, color: it.song.color });
    const repeat = S.weighting && data.hasPlays ? Math.max(1, it.count) : 1;
    it.w = repeat * Math.max(0.2, it.song.confidence || 1);
  });
  S.items = items;
  S.pts = items.filter((it) => it.song.valence != null);
  S.unplaced = items.filter((it) => it.song.valence == null);
}

function renderStats() {
  const data = S.data[S.provider];
  const songs = [...new Set(S.items.map((it) => it.song))];
  const bySource = (pre) => songs.filter((s) => (s.source || "").startsWith(pre)).length;
  const rows = [];
  if (viewOf(data) === "listened") {
    rows.push(["Plays", data.plays.length], ["Different songs", songs.length]);
  } else {
    rows.push(["Liked songs", data.likes.length]);
    if (data.hasPlays) rows.push(["Plays of these", songs.reduce((a, s) => a + s.plays, 0)]);
  }
  rows.push(["From audio analysis", bySource("reccobeats")], ["From Last.fm tags", bySource("lastfm")],
            ["No mood data", songs.filter((s) => s.valence == null).length]);
  $("stats").innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${num(v)}</dd></div>`).join("");
  $("stats").hidden = false;
  $("generated").textContent = `Last built ${fmtFull.format(new Date(data.generated_at))}.`;
}

function sourceLabel(song) {
  const match = song.match != null && song.source === "reccobeats" && S.provider === "youtube"
    ? ` via a ${Math.round(song.match * 100)}% Spotify match` : "";
  if (song.source === "reccobeats") return `Audio analysis (ReccoBeats)${match}`;
  if (song.source === "lastfm-track") return `Last.fm song tags: ${song.tags.join(", ") || "genre only"}`;
  if (song.source === "lastfm-artist") return `Last.fm artist tags: ${song.tags.join(", ") || "genre only"}`;
  return "No mood data found";
}

function itemLines(it) {
  const s = it.song;
  if (it.kind === "like") {
    return [`Liked ${fmtDay.format(it.date)}`,
            S.data[S.provider].hasPlays ? `Played ${plural(s.plays, "time", "times")} in total` : ""];
  }
  if (it.kind === "play") return [`Played ${fmtFull.format(it.date)}`, `${plural(s.plays, "play", "plays")} in total`];
  const span = it.kind === "week" ? "that week" : "that day";
  return [`${plural(it.count, "play", "plays")} ${span}, ${fmtDay.format(it.date)}`,
          `${plural(s.plays, "play", "plays")} in total`];
}

/* ------------------------------------------------------------------ plot */

function highlightSet() {
  if (S.streak) {
    const set = new Set();
    for (let i = S.streak.start; i <= S.streak.end; i++) set.add(i);
    return set;
  }
  if (S.zone) return new Set(S.pts.flatMap((p, i) => (p.zone === S.zone ? [i] : [])));
  return null;
}

const xOf = (it) => (S.axis === "date" ? it.iso : it.order);

function xRange() {
  if (!S.streak) return sweeping() ? sweepRange() : null;
  const a = S.pts[S.streak.start], b = S.pts[S.streak.end];
  if (S.axis === "order") {
    const pad = Math.max(8, (b.order - a.order) * 0.6);
    return [a.order - pad, b.order + pad];
  }
  const pad = Math.max(5 * 864e5, (b.date - a.date) * 0.6);
  return [localIso(new Date(+a.date - pad)), localIso(new Date(+b.date + pad))];
}

function inRange(range) {
  if (!range) return () => true;
  if (sweeping()) {    // by position, so the Date axis shows exactly the window's songs too
    const [a, b] = sweepEnds();
    return (it) => it.order >= a.order && it.order <= b.order;
  }
  const [a, b] = S.axis === "date" ? range.map((d) => +new Date(d)) : range;
  return (it) => { const x = S.axis === "date" ? +it.date : it.order; return x >= a && x <= b; };
}

function orderTicks(range) {
  const n = S.items.length;
  if (!n) return {};
  const lo = range ? Math.max(0, Math.ceil(range[0])) : 0;
  const hi = range ? Math.min(n - 1, Math.floor(range[1])) : n - 1;
  const fmt = !range ? fmtMonth : S.items[hi].date - S.items[lo].date < 2 * 864e5 ? fmtFull : fmtDay;
  const vals = [...new Set(Array.from({ length: 6 }, (_, k) => Math.round(lo + (k * (hi - lo)) / 5)))];
  const ticks = [];
  for (const i of vals) {    // a burst puts several ticks on one day: label each date once
    const text = fmt.format(S.items[i].date);
    if (!ticks.length || ticks[ticks.length - 1][1] !== text) ticks.push([i, text]);
  }
  return { tickvals: ticks.map((t) => t[0]), ticktext: ticks.map((t) => t[1]) };
}

/* Zoomed Date axis: the year once a range crosses one, the time when ticks fall within days
   (Plotly steps 6 or 12 hours in windows under a week, which would repeat a bare date). */
function dateTickFormat(range) {
  if (!range) return "%b %Y";
  const [a, b] = range.map((d) => new Date(d));   // local strings parse as local time
  const days = (b - a) / 864e5;
  if (days > 300) return "%b %Y";
  if (days < 7) return "%d %b %H:%M";
  return a.getFullYear() === b.getFullYear() ? "%d %b" : "%d %b %Y";
}

function markerSize(it) {
  if (!S.data[S.provider].hasPlays) return 4.5;
  return Math.min(13, 3.2 + 2.1 * Math.log2(1 + Math.max(0, it.count)));
}

/* A tube around the mood trail whose cross-section is the confidence ellipse. */
function bandMesh(pts, stats, keep) {
  // One ring per step along the time axis, so rings never stack on the same date.
  const xNum = (it) => (S.axis === "date" ? +it.date : it.order);
  const vis = pts.filter(keep);
  const span = vis.length > 1 ? xNum(vis[vis.length - 1]) - xNum(vis[0]) : 1;
  const gap = span / MAX_RINGS;
  const idx = [];
  let lastX = -Infinity;
  pts.forEach((p, i) => {
    if (keep(p) && xNum(p) - lastX >= gap) { idx.push(i); lastX = xNum(p); }
  });
  const x = [], y = [], z = [], vc = [], I = [], J = [], K = [];
  const clamp = (u) => Math.max(-1.15, Math.min(1.15, u));
  let prevRing = -1, prev = null;
  idx.forEach((i) => {
    const st = stats[i];
    if (!st.ok) { prevRing = -1; return; }
    // Don't stretch a wall across a sudden jump in the trail.
    if (prev && Math.hypot(st.v - prev.v, st.e - prev.e) > 0.35) prevRing = -1;
    prev = st;
    const base = x.length;
    const col = moodColor(st.v, st.e);
    for (let k = 0; k < RING_SIDES; k++) {
      const t = (2 * Math.PI * k) / RING_SIDES, cu = Math.cos(t), su = Math.sin(t);
      x.push(xOf(pts[i]));
      y.push(clamp(st.v + st.scale * st.l11 * cu));
      z.push(clamp(st.e + st.scale * (st.l21 * cu + st.l22 * su)));
      vc.push(col);
    }
    if (prevRing >= 0) {
      for (let k = 0; k < RING_SIDES; k++) {
        const a = prevRing + k, b = prevRing + ((k + 1) % RING_SIDES);
        const c = base + k, d = base + ((k + 1) % RING_SIDES);
        I.push(a, b); J.push(b, d); K.push(c, c);
      }
    }
    prevRing = base;
  });
  return {
    type: "mesh3d", name: "Confidence band", hoverinfo: "skip", x, y, z, i: I, j: J, k: K,
    vertexcolor: vc, opacity: 0.17, flatshading: true,
    lighting: { ambient: 1, diffuse: 0, specular: 0, roughness: 1, fresnel: 0 },
    visible: S.band && x.length > 0,
  };
}

let VISIBLE = { pts: [], unplaced: [] };   // plotted index -> item, for clicks
let TRAIL = {};                            // trail stats for the current points, reused while sweeping
const CAMERA = { eye: { x: -0.7, y: -3.0, z: 0.95 }, center: { x: 0, y: 0, z: -0.22 } };
let VIEW = { key: null, camera: CAMERA };  // the camera for this provider, view and axis

/* Plotly.react puts the camera back to the last one it saved, which undoes a rotation or
   zoom that is still going on. A sweep re-renders every step, so pass back the camera on
   screen. A new provider, view or axis starts from the default camera. */
function viewCamera(key) {
  if (VIEW.key !== key) {
    VIEW = { key, camera: CAMERA };
  } else if (S.plotted) {
    const scene = $("plot")._fullLayout?.scene?._scene;
    if (scene?.getCamera) VIEW.camera = scene.getCamera();
  }
  return VIEW.camera;
}

/* Each Plotly.react re-applies the turntable drag mode, and Plotly's camera answers by
   planning a half-second move to the view it already shows. Rotation and zoom input in
   that half second is dropped, so during a sweep (a render every step) it never lands.
   Re-apply the mode only when it changes, e.g. to pan or zoom from the mode bar. */
function keepCameraInput() {
  const scene = $("plot")._fullLayout?.scene?._scene;
  if (!scene?.updateFx || scene.updateFx.kept) return;
  const updateFx = scene.updateFx;
  let mode = scene.fullSceneLayout?.dragmode;
  scene.updateFx = function (dragmode, hovermode) {
    if (dragmode === mode) { this.fullSceneLayout.hovermode = hovermode; return; }
    mode = dragmode;
    return updateFx.call(this, dragmode, hovermode);
  };
  scene.updateFx.kept = true;
}

function render() {
  const hl = highlightSet();
  const range = xRange();
  const keep = inRange(range);          // Plotly 3D doesn't clip outside the axis range
  if (TRAIL.pts !== S.pts || TRAIL.smooth !== S.smooth || TRAIL.level !== S.level) {
    TRAIL = { pts: S.pts, smooth: S.smooth, level: S.level, stats: trailStats(S.pts, S.smooth, S.level) };
  }
  const stats = TRAIL.stats;
  const idx = S.pts.flatMap((p, i) => (keep(p) ? [i] : []));
  const pts = idx.map((i) => S.pts[i]);
  const unplaced = S.unplaced.filter(keep);
  VISIBLE = { pts, unplaced };

  const custom = (it) => [esc(it.song.name), esc(it.song.artists.join(", ")),
    itemLines(it).filter(Boolean).map(esc).join("<br>"), esc(sourceLabel(it.song))];
  const hover = "<b>%{customdata[0]}</b><br>%{customdata[1]}<br>%{customdata[2]}";

  const main = {
    type: "scatter3d", mode: "markers", name: "Songs",
    x: pts.map(xOf), y: pts.map((p) => p.v), z: pts.map((p) => p.e),
    marker: {
      size: idx.map((i) => (hl ? (hl.has(i) ? Math.max(7, markerSize(S.pts[i])) : 3) : markerSize(S.pts[i]))),
      color: idx.map((i) => (hl && !hl.has(i) ? DIM : S.pts[i].color)),
      symbol: pts.map((p) => SYMBOL[p.song.source] || "circle"),
      line: { width: 0 }, opacity: 0.95,
    },
    customdata: pts.map(custom),
    hovertemplate: hover + "<br>Valence %{y:.2f}, energy %{z:.2f}<br><i>%{customdata[3]}</i><extra></extra>",
  };

  const trail = {
    type: "scatter3d", mode: "lines", name: "Mood trail", hoverinfo: "skip",
    x: pts.map(xOf), y: idx.map((i) => stats[i].v), z: idx.map((i) => stats[i].e),
    line: { color: hl ? "rgba(30,34,48,0.22)" : "rgba(30,34,48,0.55)", width: 4 },
  };

  const floor = {
    type: "scatter3d", mode: "markers", name: "No mood data", visible: S.showUnplaced,
    x: unplaced.map(xOf), y: unplaced.map(() => 0), z: unplaced.map(() => -1.25),
    marker: { size: 2.5, color: "#9aa1b0", opacity: 0.8 },
    customdata: unplaced.map(custom),
    hovertemplate: hover + "<br><i>No mood data found</i><extra></extra>",
  };

  const band = bandMesh(S.pts, stats, keep);

  const axisBase = {
    backgroundcolor: "rgba(0,0,0,0)", gridcolor: "#d5d9e2", showbackground: false,
    zerolinecolor: "#8f96a6", showspikes: false, tickfont: { size: 11, color: "#5e6577" },
    title: { font: { size: 12, color: INK } },
  };
  const viewKey = `${S.provider}-${S.view}-${S.axis}`;
  const layout = {
    uirevision: viewKey,
    paper_bgcolor: "rgba(0,0,0,0)", margin: { l: 0, r: 0, t: 0, b: 0 }, showlegend: false,
    font: { family: getComputedStyle(document.body).fontFamily, color: INK },
    hoverlabel: { bgcolor: "#ffffff", bordercolor: "#cdd2dc", font: { color: INK, size: 12 } },
    scene: {
      aspectmode: "manual", aspectratio: { x: 2.4, y: 1, z: 1 },
      camera: viewCamera(viewKey),
      xaxis: {
        ...axisBase, title: { ...axisBase.title, text: S.axis === "date" ? "Date" : "Order" },
        type: S.axis === "date" ? "date" : "linear", zeroline: false,
        ...(S.axis === "order" ? orderTicks(range) : { tickformat: dateTickFormat(range) }),
        ...(range ? { range, autorange: false } : { autorange: true }),
      },
      yaxis: { ...axisBase, title: { ...axisBase.title, text: "Valence" }, range: [-1.15, 1.15],
               tickvals: [-1, 0, 1], ticktext: ["sad", "neutral", "happy"], zeroline: true },
      zaxis: { ...axisBase, title: { ...axisBase.title, text: "Energy" }, range: [-1.3, 1.15],
               tickvals: [-1, 0, 1], ticktext: ["calm", "", "energetic"], zeroline: true },
    },
  };

  const plot = $("plot");
  Plotly.react(plot, [main, trail, floor, band], layout, {
    displaylogo: false, responsive: true, modeBarButtonsToRemove: ["toImage", "resetCameraLastSave3d"],
  }).then(keepCameraInput);
  if (!S.plotted) {
    plot.on("plotly_click", (ev) => {
      const p = ev.points && ev.points[0];
      if (!p) return;
      if (p.curveNumber === 0) showSong(VISIBLE.pts[p.pointNumber]);
      if (p.curveNumber === 2) showSong(VISIBLE.unplaced[p.pointNumber]);
    });
    S.plotted = true;
  }
}

/* ------------------------------------------------------------------ compass */

function renderCompass() {
  const svg = $("compass");
  const C = 120, R = 100, P = (v, e) => [C + v * R, C - e * R];
  const total = S.pts.reduce((a, p) => a + p.w, 0) || 1;
  const share = (z) => Math.round((100 * S.pts.filter((p) => p.zone === z).reduce((a, p) => a + p.w, 0)) / total);

  const quarters = [
    { z: "tense",  x: C - R, y: C - R, lx: C - R + 8, ly: C - R + 16, anchor: "start" },
    { z: "bright", x: C,     y: C - R, lx: C + R - 8, ly: C - R + 16, anchor: "end" },
    { z: "low",    x: C - R, y: C,     lx: C - R + 8, ly: C + R - 22, anchor: "start" },
    { z: "calm",   x: C,     y: C,     lx: C + R - 8, ly: C + R - 22, anchor: "end" },
  ];

  let html = "";
  for (const q of quarters) {
    const dim = S.zone && S.zone !== q.z ? " dim" : "";
    html += `<rect class="quarter${dim}" data-zone="${q.z}" tabindex="0" role="button"
      aria-pressed="${S.zone === q.z}" aria-label="${ZONES[q.z].label}, ${share(q.z)} percent"
      x="${q.x + 1}" y="${q.y + 1}" width="${R - 2}" height="${R - 2}" rx="10"
      fill="${ZONES[q.z].color}" fill-opacity="0.13"></rect>`;
  }
  html += `<circle cx="${C}" cy="${C}" r="${NEUTRAL_RADIUS * R}" fill="none" stroke="#9aa1b0"
    stroke-dasharray="3 3" pointer-events="none"/>
    <line x1="${C - R}" y1="${C}" x2="${C + R}" y2="${C}" stroke="#b5bbc7" pointer-events="none"/>
    <line x1="${C}" y1="${C - R}" x2="${C}" y2="${C + R}" stroke="#b5bbc7" pointer-events="none"/>`;

  const songs = [...new Set(S.pts.map((p) => p.song))].slice(-3000);
  html += `<g pointer-events="none">`;
  for (const s of songs) {
    const [x, y] = P(s.v, s.e);
    const faded = S.zone && s.zone !== S.zone;
    html += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.7"
      fill="${faded ? DIM : s.color}" fill-opacity="${faded ? 0.5 : 0.75}"/>`;
  }
  html += `</g><g pointer-events="none" paint-order="stroke" stroke="#f7f8fa" stroke-width="3">`;
  for (const q of quarters) {
    html += `<text class="q-label" x="${q.lx}" y="${q.ly}" text-anchor="${q.anchor}">${ZONES[q.z].short}</text>
      <text x="${q.lx}" y="${q.ly + 14}" text-anchor="${q.anchor}">${share(q.z)}%</text>`;
  }
  html += `<text class="axis-label" x="${C + R + 4}" y="${C + 3}">happy</text>
    <text class="axis-label" x="${C - R - 4}" y="${C + 3}" text-anchor="end">sad</text>
    <text class="axis-label" x="${C}" y="${C - R - 6}" text-anchor="middle">energetic</text>
    <text class="axis-label" x="${C}" y="${C + R + 14}" text-anchor="middle">calm</text></g>`;
  svg.innerHTML = html;

  svg.querySelectorAll(".quarter").forEach((el) => {
    const toggle = () => { S.zone = S.zone === el.dataset.zone ? null : el.dataset.zone; S.streak = null; update(); };
    el.addEventListener("click", toggle);
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); }
    });
  });
  $("compass-hint").textContent = S.data[S.provider].hasPlays && S.weighting
    ? "Shares are weighted by plays. Click a quarter to show only those songs."
    : "Click a quarter to show only those songs.";
}

/* ------------------------------------------------------------------ streak list */

function describe(st) {
  const base = `${st.count} ${ZONES[st.zone].word} songs`;
  const tail = st.off ? `, ${st.off} off-mood` : " in a row";
  return base + tail;
}

function when(st) {
  return st.from.toDateString() === st.to.toDateString()
    ? fmtDay.format(st.from) : fmtDay.formatRange(st.from, st.to);
}

function renderStreaks() {
  const list = S.zone ? S.streaks.filter((s) => s.zone === S.zone) : S.streaks;
  const hasPlays = S.data[S.provider].hasPlays;
  if (!list.length) {
    $("streak-summary").textContent = S.zone
      ? `No ${ZONES[S.zone].word} streaks at this length. Lower the streak length above.`
      : "No streaks at this length. Lower the streak length above.";
  } else {
    const longest = list.reduce((a, b) => (b.count > a.count ? b : a));
    $("streak-summary").textContent =
      `${list.length} found. The longest is ${longest.count} ${ZONES[longest.zone].word} songs, ${when(longest)}.`;
  }

  $("streaks").innerHTML = list.slice(0, 200).map((st) => {
    const i = S.streaks.indexOf(st);
    const names = [...new Set(S.pts.slice(st.start, st.end + 1).filter((p) => p.zone === st.zone)
      .map((p) => p.song.name))].slice(0, 3).join(", ");
    const plays = hasPlays && st.plays !== st.count ? `, ${plural(st.plays, "play", "plays")}` : "";
    return `<li><button type="button" class="streak" data-i="${i}" aria-pressed="${S.streak === st}">
      <span class="bar" style="background:${ZONES[st.zone].color}"></span>
      <span><strong>${esc(describe(st))}</strong><span class="when">${esc(when(st) + plays)}</span>
      <span class="songs">${esc(names)}</span></span></button></li>`;
  }).join("");

  $("streaks").querySelectorAll(".streak").forEach((btn) => btn.addEventListener("click", () => {
    const st = S.streaks[+btn.dataset.i];
    S.streak = S.streak === st ? null : st;
    stopSweep();                          // a streak takes over the time axis
    S.sweepOn = false;
    update();
  }));
  $("clear-selection").hidden = !(S.streak || S.zone);
}

/* ------------------------------------------------------------------ song card */

function showSong(it) {
  if (!it) return;
  const s = it.song, img = s.image_large || s.image;
  const meter = s.valence == null ? "" :
    `<div class="meter"><span>Valence</span><span>${s.v.toFixed(2)} (${s.v >= 0 ? "happier" : "sadder"})</span>
     <span>Energy</span><span>${s.e.toFixed(2)} (${s.e >= 0 ? "more energetic" : "calmer"})</span></div>`;
  const link = s.url ? `<p><a href="${esc(s.url)}" target="_blank" rel="noopener">Open in ${PROVIDER_NAME[S.provider]}</a></p>` : "";
  $("song-card").innerHTML = `<div class="song">
      ${img ? `<img src="${esc(img)}" alt="">` : `<div class="art"></div>`}
      <div><h3>${esc(s.name)}</h3><p>${esc(s.artists.join(", "))}</p>
        ${itemLines(it).filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join("")}
        ${meter}<p>${esc(sourceLabel(s))}</p>${link}
      </div></div>`;
  $("song-block").hidden = false;
}

/* ------------------------------------------------------------------ sweep */

/* A window of S.sweepSize songs that have a mood (S.pts) sliding along the time axis.
   Positions are indices into S.pts, so the window shows the same songs on either axis. */
let SWEEP_TIMER = null;
const SWEEP_STEP_MS = 120, SWEEP_STEPS_PER_WINDOW = 15, SWEEP_SIZES = [100, 300, 1000];
/* Plotly applies a drag or wheel turn a moment later, and a render in between drops it.
   So the sweep holds still while the chart is being turned, and a moment after. */
let TURNING = false, HOLD_UNTIL = 0;
const turning = () => TURNING || performance.now() < HOLD_UNTIL;
const PLAY_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 2.5v11l9.5-5.5z" fill="currentColor"/></svg>`;
const PAUSE_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor"/></svg>`;

const SWEEP_UNIT = { like: ["song", "songs"], play: ["play", "plays"], day: ["dot", "dots"], week: ["dot", "dots"] };
const sweepUnit = () => SWEEP_UNIT[S.pts.length ? S.pts[0].kind : "like"];
const sweepSize = () => Math.min(S.sweepSize, S.pts.length);
const sweepMax = () => Math.max(0, S.pts.length - sweepSize());
const sweepEnds = () => [S.pts[S.sweepStart], S.pts[S.sweepStart + sweepSize() - 1]];
const sweeping = () => S.sweepOn && !S.streak && sweepMax() > 0;   // a window of every song shows all

function sweepRange() {
  const [a, b] = sweepEnds();
  if (S.axis === "order") return [a.order - 0.5, b.order + 0.5];
  const pad = Math.max(60000, (b.date - a.date) * 0.02);   // keeps the end dots off the axis edges
  return [localIso(new Date(+a.date - pad)), localIso(new Date(+b.date + pad))];
}

function syncSweep() {
  const n = S.pts.length, pos = $("sweep-pos"), bar = $("sweep");
  const hide = n < 2 || !S.data[S.provider] || !$("overlay").hidden;
  if (bar.hidden !== hide) {
    bar.hidden = hide;
    if (S.plotted) {                                 // the bar takes height from the plot
      const plot = $("plot");
      plot.layout.scene.camera = viewCamera(VIEW.key);   // a resize re-applies the layout's camera
      Plotly.Plots.resize(plot);
    }
  }
  const whole = sweepMax() === 0;                    // the window already holds every song
  pos.max = sweepMax();
  pos.value = S.sweepStart;
  pos.disabled = whole;
  $("sweep-play").disabled = whole;
  // All while everything is on the chart, the size while sweeping, nothing while a streak is.
  setSegment("sweep", sweeping() ? String(S.sweepSize) : S.streak ? null : "all");
  document.querySelectorAll("[data-sweep]").forEach((b) => {
    if (b.dataset.sweep !== "all") b.disabled = +b.dataset.sweep >= n;   // would show all anyway
  });
  $("sweep-play").innerHTML = SWEEP_TIMER ? PAUSE_ICON : PLAY_ICON;
  $("sweep-play").setAttribute("aria-label", SWEEP_TIMER ? "Pause" : "Play");
  const [one, many] = sweepUnit();
  let label = "";
  if (sweeping()) {
    const [a, b] = sweepEnds();
    const span = a.date.toDateString() === b.date.toDateString()
      ? fmtDay.format(a.date) : fmtDay.formatRange(a.date, b.date);
    label = `${span} · ${many} ${num(S.sweepStart + 1)}–${num(S.sweepStart + sweepSize())} of ${num(n)}`;
  } else if (n) {
    const shown = S.streak ? `Showing the streak ${when(S.streak)}`
      : `Showing all ${plural(n, one, many)} with a mood · ${fmtMonth.formatRange(S.pts[0].date, S.pts[n - 1].date)}`;
    label = shown + (whole ? "" : ` · press play to sweep ${num(sweepSize())} at a time`);
  }
  $("sweep-label").textContent = label;
  pos.setAttribute("aria-valuetext", label);
  // The dark stretch of the track is what the chart shows: everything, the window (the thumb
  // always sits inside it), or a selected streak.
  let from = 0, to = 1;
  if (sweeping()) {
    const w = sweepSize() / n;
    from = (S.sweepStart / sweepMax()) * (1 - w);
    to = from + w;
  } else if (S.streak && n) {
    from = S.streak.start / n;
    to = (S.streak.end + 1) / n;
  }
  pos.style.setProperty("--a", `${(100 * from).toFixed(2)}%`);
  pos.style.setProperty("--b", `${(100 * to).toFixed(2)}%`);
}

function sweepTo(start) {
  if (!S.data[S.provider]) return;       // the next dataset is still loading
  S.sweepOn = true;
  S.sweepStart = Math.max(0, Math.min(sweepMax(), start));
  if (S.streak) { S.streak = null; update(); } else { render(); syncSweep(); }
}

function stopSweep() {
  clearTimeout(SWEEP_TIMER);
  SWEEP_TIMER = null;
}

function toggleSweep() {
  if (SWEEP_TIMER) { stopSweep(); syncSweep(); return; }
  const tick = () => {
    if (!S.data[S.provider] || S.sweepStart >= sweepMax()) { SWEEP_TIMER = null; syncSweep(); return; }
    if (!turning()) sweepTo(S.sweepStart + Math.max(1, Math.round(sweepSize() / SWEEP_STEPS_PER_WINDOW)));
    SWEEP_TIMER = setTimeout(tick, SWEEP_STEP_MS);
  };
  sweepTo(S.sweepStart < sweepMax() ? S.sweepStart : 0);   // from the thumb; at the end, start over
  SWEEP_TIMER = setTimeout(tick, SWEEP_STEP_MS);
  syncSweep();
}

/* ------------------------------------------------------------------ update loop */

function update() {
  S.streaks = findStreaks(S.pts, S.minLen, S.tolerance);
  if (S.streak) {
    S.streak = S.streaks.find((s) => s.zone === S.streak.zone && s.start === S.streak.start) || null;
  }
  renderCompass();
  renderStreaks();
  syncSweep();      // before render: showing the bar changes the plot's height
  render();
}

function refreshView() {
  S.zone = null; S.streak = null;
  stopSweep();
  const from = S.pts[S.sweepStart]?.date;
  buildItems();
  // A new grouping or view reorders the songs: keep the window (or the thumb) on the same dates.
  const at = from ? S.pts.findIndex((p) => p.date >= from) : S.sweepStart;
  S.sweepStart = at < 0 ? sweepMax() : Math.min(at, sweepMax());
  renderStats();
  syncControls();
  if (!S.pts.length) {
    const data = S.data[S.provider];
    const noSource = S.provider === "youtube" && !data.lastfm_enabled && !data.spotify_matching;
    overlay(`${STRIP}<h2>No song got a mood yet</h2>${noSource
      ? `<p>No mood source was set when this was built. Add a Last.fm key (or Spotify), then rebuild.</p>
         <div class="actions"><button type="button" class="btn" data-keys>Add API keys</button>
           <button type="button" class="text-btn" id="rebuild-now">Rebuild</button></div>`
      : `<p>Neither ReccoBeats nor Last.fm returned data for this view. Check the terminal for errors, then rebuild.</p>`}`,
    { solid: false });
    $("rebuild-now")?.addEventListener("click", () => startBuild(S.provider));
  } else {
    hideOverlay();
  }
  update();
}

/* ------------------------------------------------------------------ controls */

function setSegment(attr, value) {
  document.querySelectorAll(`[data-${attr}]`).forEach((b) =>
    b.setAttribute("aria-checked", String(b.dataset[attr] === value)));
}

function syncControls() {
  const data = S.data[S.provider];
  const hasPlays = !!(data && data.hasPlays);
  const view = data ? viewOf(data) : S.view;
  setSegment("provider", S.provider);
  setSegment("view", view);
  setSegment("axis", S.axis);
  setSegment("group", S.group);
  const listenBtn = document.querySelector('[data-view="listened"]');
  listenBtn.disabled = S.provider === "spotify";
  listenBtn.title = S.provider === "spotify" ? "Spotify's API only shares your last 50 plays" : "";
  const likedBtn = document.querySelector('[data-view="liked"]');
  likedBtn.disabled = hasPlays && !data.likes.length;
  likedBtn.title = likedBtn.disabled ? "This export has no liked songs file" : "";
  $("group-row").hidden = view !== "listened";
  $("weighting-row").hidden = !hasPlays;
  $("weighting").checked = S.weighting;
  $("band").checked = S.band;
  $("level").value = S.level;
  $("level-out").textContent = S.level;
  $("level-row").classList.toggle("off", !S.band);
  $("spotify-actions").hidden = S.provider !== "spotify";
  // New Spotify keys sign you out; offer the way back in next to the chart.
  $("reconnect").hidden = !(S.status?.spotify?.configured && !S.status.spotify.authenticated);
  $("youtube-actions").hidden = S.provider !== "youtube";
  $("side").hidden = !data;
}

function bindControls() {
  const slider = (id, key, after = update) => {
    const el = $(id);
    el.addEventListener("input", () => { S[key] = +el.value; $(`${id}-out`).textContent = el.value; savePrefs(); after(); });
  };
  slider("min-len", "minLen");
  slider("tolerance", "tolerance");
  slider("smooth", "smooth", render);
  slider("level", "level", render);

  const segment = (attr, fn) => document.querySelectorAll(`[data-${attr}]`).forEach((btn) =>
    btn.addEventListener("click", () => { if (!btn.disabled) fn(btn.dataset[attr]); }));
  segment("provider", (p) => {
    S.provider = p; S.sweepOn = false; S.sweepStart = 0;
    S.items = []; S.pts = [];            // another library: nothing to carry the sweep over from
    savePrefs(); showProvider();
  });
  // No data yet, or a build running under its overlay: these would rebuild a view that isn't there.
  const busy = () => !S.data[S.provider] || S.status?.job?.status === "running";
  segment("view", (v) => { if (busy()) return; S.view = v; savePrefs(); refreshView(); });
  segment("axis", (a) => { S.axis = a; savePrefs(); setSegment("axis", a); render(); });
  segment("group", (g) => { if (busy()) return; S.group = g; savePrefs(); refreshView(); });
  segment("sweep", (v) => {
    if (v === "all") { stopSweep(); S.sweepOn = false; render(); syncSweep(); return; }
    S.sweepSize = +v; savePrefs();
    sweepTo(S.sweepStart);               // show a window of that size, from the thumb
  });

  $("sweep-play").addEventListener("click", toggleSweep);
  const plotEl = $("plot");
  plotEl.addEventListener("pointerdown", () => { TURNING = true; }, true);
  const endTurn = () => { if (TURNING) { TURNING = false; HOLD_UNTIL = performance.now() + 250; } };
  window.addEventListener("pointerup", endTurn);
  window.addEventListener("pointercancel", endTurn);
  plotEl.addEventListener("wheel", () => { HOLD_UNTIL = performance.now() + 400; }, { capture: true, passive: true });
  $("sweep-pos").addEventListener("input", (ev) => sweepTo(+ev.target.value));

  $("weighting").addEventListener("change", (ev) => {
    if (busy()) { ev.target.checked = S.weighting; return; }
    S.weighting = ev.target.checked; savePrefs(); refreshView();
  });
  $("band").addEventListener("change", (ev) => { S.band = ev.target.checked; savePrefs(); syncControls(); render(); });
  $("show-unplaced").addEventListener("change", (ev) => { S.showUnplaced = ev.target.checked; render(); });
  $("clear-selection").addEventListener("click", () => { S.streak = null; S.zone = null; update(); });
  $("refresh").addEventListener("click", () => startBuild("spotify"));
  $("rebuild").addEventListener("click", () => startBuild("youtube"));
  $("reimport").addEventListener("click", () => showYoutubeImport(S.status.youtube.takeout, true));
  $("disconnect").addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    location.href = "/";
  });
  // "API keys" buttons live in the sidebar and in several overlays.
  // Not during a build: the form would replace the progress screen that the build updates.
  document.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-keys]") && S.status?.job?.status !== "running") showKeys();
  });
}

/* ------------------------------------------------------------------ app states */

function overlay(html, { solid = true } = {}) {
  $("overlay-panel").innerHTML = html;
  $("overlay").style.background = solid ? "var(--mist)" : "rgba(232,235,241,0.88)";
  $("overlay").hidden = false;
  stopSweep();
  syncSweep();                           // no sweeping under an overlay
}
const hideOverlay = () => { $("overlay").hidden = true; syncSweep(); };

const STRIP = `<div class="mood-strip">${STREAK_ZONES.map((z) =>
  `<i style="background:${ZONES[z].color}"></i>`).join("")}</div>`;

function clearChart() {
  stopSweep();
  if (S.plotted) Plotly.purge($("plot"));
  S.plotted = false;
  $("stats").hidden = true;
  $("side").hidden = true;
  $("sweep").hidden = true;
}

/* Paste API keys instead of editing .env. The server checks each with its service, saves the
   good ones to .env on this computer and uses them at once. Saved keys never come back here. */
function showKeys() {
  const st = S.status;
  const saved = (on) => (on && !st.demo ? ` <span class="saved">saved</span>` : "");
  overlay(`${STRIP}<h2>API keys</h2>
    <p>Keys stay on this computer, in the <code>.env</code> file next to <code>app.py</code>.
      Leave a field empty to keep what's there.</p>
    <label class="field"><span>Last.fm API key${saved(st.has_lastfm)}</span>
      <input id="key-lastfm" autocomplete="off" spellcheck="false"></label>
    <p class="hint">Free and instant at <a href="https://www.last.fm/api/account/create" target="_blank" rel="noopener">last.fm/api/account/create</a>.
      Moods come from listeners' tags.</p>
    <label class="field"><span>Spotify client ID${saved(st.spotify.configured)}</span>
      <input id="key-spotify-id" autocomplete="off" spellcheck="false"></label>
    <label class="field"><span>Spotify client secret</span>
      <input id="key-spotify-secret" type="password" autocomplete="off"></label>
    <p class="hint">From your app at <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a>,
      with the redirect URI <code>${esc(st.spotify.redirect_uri)}</code>. Moods measured from the audio; the app's owner needs Premium.</p>
    <p class="progress-text" id="keys-msg" role="status"></p>
    <div class="actions"><button type="button" class="btn" id="keys-save">Save</button>
      <button type="button" class="text-btn" id="keys-back">Back</button></div>`);
  // Over a chart, go back to it as it was (zoom, streak, quarter); otherwise redraw the screen,
  // which may now offer more (e.g. Connect Spotify once its keys are in).
  $("keys-back").addEventListener("click", () => {
    if (S.data[S.provider] && S.pts.length) { hideOverlay(); syncControls(); } else showProvider();
  });
  const inputs = { lastfm: "key-lastfm", spotify_id: "key-spotify-id", spotify_secret: "key-spotify-secret" };
  Object.values(inputs).forEach((id) => $(id).addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !$("keys-save").disabled) $("keys-save").click();
  }));
  $("keys-save").addEventListener("click", async () => {
    const body = Object.fromEntries(Object.entries(inputs).map(([k, id]) => [k, $(id).value.trim()]));
    const buttons = [$("keys-save"), $("keys-back")];
    buttons.forEach((b) => { b.disabled = true; });
    $("keys-msg").textContent = "Checking the keys…";
    let out;
    try {
      const res = await fetch("/api/keys", { method: "POST", headers: { "Content-Type": "application/json" },
                                             body: JSON.stringify(body) });
      out = await res.json().catch(() => ({ error: `Saving failed (error ${res.status}). See the terminal running app.py.` }));
    } catch {
      out = { error: "The app didn't answer. Is app.py still running?" };
    }
    try { S.status = await (await fetch("/api/status")).json(); } catch { /* keep the last status */ }
    if (!$("keys-msg")) return;            // the form was closed meanwhile
    buttons.forEach((b) => { b.disabled = false; });
    if (out.error) {
      $("keys-msg").innerHTML = `<span class="error">${esc(out.error)}</span>`;
      return;
    }
    const said = {
      lastfm: { ok: "Last.fm key works and is saved.", rejected: "Last.fm rejected this key, so it wasn't saved.",
                unchecked: "Couldn't reach Last.fm to check the key; saved it anyway." },
      spotify: { ok: "Spotify keys work and are saved.", rejected: "Spotify rejected this client ID and secret, so they weren't saved.",
                 unchecked: "Couldn't reach Spotify to check the keys; saved them anyway." },
    };
    $("keys-msg").innerHTML = Object.entries(out).map(([k, v]) =>
      `<span class="${v === "rejected" ? "error" : "saved"}">${esc(said[k][v])}</span>`).join("<br>");
    for (const [k, v] of Object.entries(out)) {          // clear what was saved, keep what to fix
      if (v === "rejected") continue;
      (k === "lastfm" ? ["key-lastfm"] : ["key-spotify-id", "key-spotify-secret"]).forEach((id) => { $(id).value = ""; });
    }
    $("keys-back").textContent = "Done";
  });
  $("key-lastfm").focus();
}

function showSpotifySetup(st) {
  overlay(`${STRIP}<h2>Connect a Spotify app first</h2>
    <p>The timeline reads your Liked Songs through your own Spotify developer app.</p>
    <ol>
      <li>Open <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a>, create an app and choose Web API.</li>
      <li>Add this redirect URI exactly: <code>${esc(st.spotify.redirect_uri)}</code></li>
      <li>Paste its Client ID and Client secret under API keys. A Last.fm key there too gives songs
        ReccoBeats doesn't know a mood.</li>
    </ol>
    <button type="button" class="btn big" data-keys>Enter API keys</button>
    <p class="note">To look around first, run <code>python app.py --demo</code>.</p>`);
}

function showSpotifyConnect(error) {
  overlay(`${STRIP}<h2>Connect Spotify</h2>
    ${error ? `<p class="error">Spotify sign-in didn't finish (${esc(error)}). Try again.</p>` : ""}
    <p>The app only asks to read your Liked Songs. The sign-in token stays in
      <code>data/.spotify-token</code> on this PC.</p>
    <a class="btn big" href="/login">Connect Spotify</a>
    <p class="note"><button type="button" class="text-btn" data-keys>Change API keys</button></p>`);
}

function showSpotifyBuild(st) {
  const lastfm = st.has_lastfm ? "" :
    `<p>Last.fm fallback is off, so songs ReccoBeats doesn't know will have no mood.
     <button type="button" class="text-btn" data-keys>Add a Last.fm key</button></p>`;
  overlay(`${STRIP}<h2>Build your Spotify timeline</h2>
    <p>The first run looks up every liked song, which can take a few minutes for a big library.
      Later runs only look up songs you liked since.</p>${lastfm}
    <button type="button" class="btn big" id="build-now">Build my timeline</button>`);
  $("build-now").addEventListener("click", () => startBuild("spotify"));
}

function matchingNote(st) {
  if (st.youtube.spotify_matching) return "";
  const keys = (label) => `<button type="button" class="text-btn" data-keys>${label}</button>`;
  const connect = `<a href="/login">Connect Spotify</a>`;
  if (!st.has_lastfm) {      // Spotify keys alone don't help until Spotify is connected
    return `<p class="error">No mood source yet: songs need a Last.fm key or a Spotify connection to get a mood.
      ${st.spotify.configured ? `${connect} or ${keys("add a Last.fm key")}` : keys("Add API keys")}</p>`;
  }
  return `<p class="note">YouTube songs are matched to Spotify to look up how they sound. Without a
    Spotify connection, moods come from Last.fm tags only. ${st.spotify.configured ? connect : keys("Add Spotify keys")}
    for better coverage.</p>`;
}

function showYoutubeImport(takeout, again = false) {
  const html = takeout && takeout.html_history
    ? `<p class="error">Your watch history is in HTML. Export it again and choose JSON for history (step 3).</p>` : "";
  overlay(`${STRIP}<h2>${again ? "Import a new" : "Import your"} YouTube Music export</h2>
    <ol>
      <li>Open <a href="https://takeout.google.com" target="_blank" rel="noopener">takeout.google.com</a>, click Deselect all, then tick YouTube and YouTube Music.</li>
      <li>Click All YouTube data included and keep only history and playlists.</li>
      <li>Click Multiple formats and set history to JSON.</li>
      <li>Create the export, download the zip, and choose it below. Several zips at once are fine.</li>
    </ol>${html}
    <label class="file">
      <input type="file" id="takeout-files" multiple accept=".zip,.json,.csv,.html">
      <span>Choose Takeout zip</span>
    </label>
    <p class="progress-text" id="upload-status"></p>
    ${matchingNote(S.status)}
    ${again ? `<button type="button" class="text-btn" id="cancel-import">Keep the current data</button>` : ""}`,
    { solid: !again });
  $("takeout-files").addEventListener("change", uploadTakeout);
  if (again) $("cancel-import").addEventListener("click", hideOverlay);
}

async function uploadTakeout(ev) {
  const files = [...ev.target.files];
  if (!files.length) return;
  const form = new FormData();
  files.forEach((f) => form.append("files", f));
  $("upload-status").textContent = `Reading ${plural(files.length, "file", "files")}`;
  const res = await fetch("/api/youtube/upload", { method: "POST", body: form });
  const scan = await res.json();
  if (res.ok && scan.has_files) S.status.youtube.takeout = scan;
  if (!$("upload-status")) return;       // the user moved on (e.g. to API keys); Back shows the result
  if (!res.ok || !scan.has_files) {
    $("upload-status").textContent = scan.html_history
      ? "Only an HTML history was found. Export again with JSON for history."
      : "No watch history or playlists were found in those files.";
    return;
  }
  showYoutubeBuild(scan);
}

function showYoutubeBuild(scan) {
  const range = scan.first
    ? ` from ${fmtDay.format(new Date(scan.first))} to ${fmtDay.format(new Date(scan.last))}` : "";
  const likely = scan.playlists.find((p) => p.likely_likes && p.dated) || null;
  const options = [`<option value="">No liked songs, history only</option>`].concat(
    scan.playlists.map((p) => `<option value="${esc(p.file)}" ${likely && likely.file === p.file ? "selected" : ""}>
      ${esc(p.file)} (${plural(p.rows, "item", "items")})</option>`)).join("");
  overlay(`${STRIP}<h2>Build your YouTube Music timeline</h2>
    <p>Found ${plural(scan.plays, "play", "plays")} of ${plural(scan.songs, "song", "songs")}${range}.</p>
    ${scan.html_history ? `<p class="error">Your watch history is in HTML with dates this app can't read, so it was left out.
      Export it again and choose JSON for history, or build from a liked songs file only.</p>` : ""}
    <label class="select"><span>Which file holds your liked songs?</span>
      <select id="likes-file">${options}</select></label>
    <p class="hint">Liked videos that aren't songs are left out.</p>
    ${matchingNote(S.status)}
    <div class="actions"><button type="button" class="btn big" id="build-yt">Build my timeline</button>
      <button type="button" class="text-btn" id="other-files">Choose other files</button>
      ${S.data.youtube ? `<button type="button" class="text-btn" id="keep-data">Keep the current data</button>` : ""}</div>`);
  if (S.data.youtube) $("keep-data").addEventListener("click", hideOverlay);
  $("build-yt").addEventListener("click", () => { S.likesFile = $("likes-file").value; startBuild("youtube", S.likesFile); });
  $("other-files").addEventListener("click", () => showYoutubeImport(null));
}

async function startBuild(provider, likesFile) {
  if (S.status) S.status.job.status = "running";   // block the keys form before the first poll
  await fetch("/api/build", { method: "POST", headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ provider, likes_file: likesFile === undefined ? null : likesFile }) });
  watchJob();
}

function watchJob() {
  overlay(`<h2>Building your ${PROVIDER_NAME[S.provider]} timeline</h2>
    <div class="progress"><span id="bar"></span></div>
    <p class="progress-text" id="progress-text">Starting</p>`, { solid: !S.data[S.provider] });

  const tick = async () => {
    const st = await (await fetch("/api/status")).json();
    S.status = st;
    const job = st.job;
    if (job.status === "running" || job.status === "idle") {
      if ($("bar")) {                    // keep polling even if the progress screen was replaced
        $("bar").style.width = `${job.total ? Math.min(100, (100 * job.done) / job.total) : 4}%`;
        $("progress-text").textContent = job.total
          ? `${job.step}: ${num(job.done)} of ${num(job.total)}` : job.step || "Starting";
      }
      setTimeout(tick, 700);
    } else if (job.status === "done") {
      S.data[job.provider] = null;
      S.provider = job.provider;
      showProvider();
    } else {
      const signIn = job.provider === "spotify" && st.spotify.configured && !st.spotify.authenticated;
      overlay(`<h2>The build stopped</h2><p class="error">${esc(job.error)}</p>
        <p>Details are in the terminal running <code>app.py</code>.</p>
        <div class="actions">${signIn ? `<a class="btn" href="/login">Connect Spotify</a>` : ""}
          <button type="button" class="${signIn ? "text-btn" : "btn"}" id="retry">Try again</button></div>`);
      $("retry").addEventListener("click", () => startBuild(job.provider));
    }
  };
  tick();
}

async function loadData(provider) {
  if (S.data[provider]) return true;
  const res = await fetch(`/api/data/${provider}`);
  if (!res.ok) return false;
  S.data[provider] = prepareDataset(await res.json());
  return true;
}

async function showProvider() {
  stopSweep();                           // a tick while the data loads would render stale items
  syncSweep();                           // and hides the bar until this provider's data is in
  const st = S.status;
  setSegment("provider", S.provider);
  const info = st[S.provider];
  if (info.has_data && (await loadData(S.provider))) {
    refreshView();
    return;
  }
  clearChart();
  if (S.provider === "spotify") {
    const authError = new URLSearchParams(location.search).get("auth_error");
    if (!info.configured) return showSpotifySetup(st);
    if (!info.authenticated) return showSpotifyConnect(authError);
    return showSpotifyBuild(st);
  }
  if (info.takeout && info.takeout.has_files) return showYoutubeBuild(info.takeout);
  showYoutubeImport(info.takeout);
}

async function boot() {
  loadPrefs();
  const params = new URLSearchParams(location.search);
  if (params.get("provider")) S.provider = params.get("provider");
  S.status = await (await fetch("/api/status")).json();
  if (S.status.demo) document.title = "Mood timeline (demo)";
  if (S.status.job.status === "running") {
    S.provider = S.status.job.provider;
    setSegment("provider", S.provider);   // the page's HTML defaults to Spotify, Liked
    setSegment("view", S.provider === "spotify" ? "liked" : S.view);
    return watchJob();
  }
  showProvider();
}

bindControls();
boot();
