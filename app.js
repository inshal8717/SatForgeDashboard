"use strict";
/* FalconEye Helios Shield dashboard.
   Data comes from one of two places: the built-in simulation, or live JSON packets
   (polled from a URL, posted to /api/telemetry, or pasted). See README.md for the packet format. */

/* ---- Constants and thresholds ---- */
const BASE_CPM = 18, SIG = Math.sqrt(18), CPM_WARN = BASE_CPM + 2 * SIG, CPM_ALERT = BASE_CPM + 3 * SIG;
const B_BASE = 50;            // placeholder Earth-field baseline, µT
const MAG_WARN = 5, MAG_ALERT = 10;
const UV_WARN = 8;
const FLARE_WARN = 50, FLARE_ALERT = 80;
const N = 120;
const TZ = { timeZone: "Asia/Dubai", hour12: false };
const C = { ok: "#3ecf8e", warn: "#f2c14b", alert: "#ff5d5d", amber: "#f2a93b", rad: "#5fd3e0", grid: "#213039", mute: "#8a9ca8", sim: "#7aa7ff" };
const LEVEL_COLOR = { NORMAL: C.ok, WARNING: C.warn, ALERT: C.alert };
const RANK = { NORMAL: 0, WARNING: 1, ALERT: 2 };
const EVENT_NAMES = { solar: "Solar particle event", magnetic: "Magnetic storm", uv: "UV peak" };

/* Accepted key names in an incoming packet (first match wins). */
const KEYS = {
  uv: ["uv_index", "uv", "uvIndex"],
  dB: ["field_delta_uT", "field_uT", "field_delta", "dB"],
  temp: ["temp_C", "temp", "temperature"],
  cpm: ["gamma_cpm", "cpm", "gamma"],
  flare: ["flare_index", "flare"]
};
const CANON = { uv: "uv_index", dB: "field_delta_uT", temp: "temp_C", cpm: "gamma_cpm", flare: "flare_index" };
const PAYLOAD_FIELDS = ["uv", "dB", "temp"];     // real payload channels; gamma and flare are simulated inputs

const $ = id => document.getElementById(id);

/* ---- State ---- */
let mode = "sim", scen = "solar";
let series = [], k = 0, prevLevel = "NORMAL", alerts = 0, loraN = 0, loraSeq = 0, lastLora = null, logRows = [], trail = [];
let lastLoraAtMs = 0, lastSentLevel = "NORMAL";
let modeStart = Date.now();
let simTimer = null, pollTimer = null, pollBusy = false;
const feed = { url: "", every: 2, lastPktAt: 0, lastKey: null, lastErr: "", count: 0, manual: false };

/* ---- Simulation (per second, k counts from the start of the chosen event) ---- */
function gauss() { return (Math.random() + Math.random() + Math.random() - 1.5) * 2; }
function bump(x, a, b, c, d) {
  if (x <= a || x >= d) return 0;
  if (x < b) return (x - a) / (b - a);
  if (x <= c) return 1;
  return (d - x) / (d - c);
}
function sample(n) {
  const ph = n % 200;
  let uv = 4 + 1.2 * Math.sin(n / 30) + 0.2 * gauss();
  let dB = 0.4 * gauss();                          // field change around baseline
  let cpm = BASE_CPM + SIG * gauss();              // gamma threat input (simulated)
  let flare = 15 + 3 * gauss();                    // flare index (simulated)
  if (scen === "solar") {
    const b = bump(ph, 8, 12, 60, 70);
    cpm += 42 * b; flare += 70 * b;
  }
  if (scen === "magnetic") { dB += 14 * bump(ph, 8, 14, 60, 70); }
  if (scen === "uv") { uv += 5.2 * bump(ph, 6, 10, 40, 50); }
  return {
    uv: Math.max(0, uv),
    dB: Math.abs(dB),
    cpm: Math.max(0, cpm),
    flare: Math.max(0, Math.min(100, flare)),
    temp: 27 + 2 * Math.sin(n / 50) + 0.2 * gauss()
  };
}

const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
const hms = d => d.toLocaleTimeString("en-GB", TZ);
const met = s => {
  const p = n => String(n).padStart(2, "0");
  return `T+ ${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
};

/* ---- Incoming packets: normalise to the internal sample shape ---- */
function pick(o, names) {
  for (const n of names) {
    const raw = o[n];
    if (raw === undefined || raw === null || raw === "") continue;
    const v = Number(raw);
    if (Number.isFinite(v)) return v;
  }
  return null;
}
function carry(field, fallback) {
  for (let i = series.length - 1; i >= 0; i--) if (Number.isFinite(series[i][field])) return series[i][field];
  return fallback;
}
function normalize(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const found = {};
  let any = false;
  for (const f in KEYS) { found[f] = pick(o, KEYS[f]); if (found[f] !== null) any = true; }
  if (!any) return null;
  const fill = {
    uv: carry("uv", 0), dB: carry("dB", 0), temp: carry("temp", 25),
    cpm: BASE_CPM + SIG * gauss(), flare: 15 + 3 * gauss()
  };
  const s = {}, filled = [];
  for (const f in KEYS) {
    if (found[f] === null) { filled.push(CANON[f]); s[f] = fill[f]; } else s[f] = found[f];
  }
  s.uv = Math.max(0, s.uv); s.dB = Math.abs(s.dB); s.cpm = Math.max(0, s.cpm);
  s.flare = Math.max(0, Math.min(100, s.flare));
  const missingPayload = PAYLOAD_FIELDS.filter(f => found[f] === null).map(f => CANON[f]);
  // LIVE only when the sender says so and every payload channel is really in the packet.
  const src = String(o.source || "").toUpperCase() === "LIVE" && !missingPayload.length ? "LIVE" : "SIM";
  const key = o.seq !== undefined ? "seq:" + o.seq : (o.t !== undefined ? "t:" + o.t : null);
  return { s, src, filled, missingPayload, key };
}

/* ---- Channel evaluation ---- */
function evaluate(s) {
  const cpmAvg = avg(series.slice(-5).map(p => p.cpm));
  const dBAvg = avg(series.slice(-5).map(p => p.dB));
  const chans = {
    UV: s.uv >= UV_WARN ? "WARNING" : "NORMAL",
    MAGNETIC: dBAvg > MAG_ALERT ? "ALERT" : (dBAvg > MAG_WARN ? "WARNING" : "NORMAL"),
    GAMMA: cpmAvg > CPM_ALERT ? "ALERT" : (cpmAvg > CPM_WARN ? "WARNING" : "NORMAL"),
    FLARE: s.flare >= FLARE_ALERT ? "ALERT" : (s.flare >= FLARE_WARN ? "WARNING" : "NORMAL")
  };
  let level = "NORMAL";
  Object.values(chans).forEach(v => { if (RANK[v] > RANK[level]) level = v; });
  return { chans, level, cpmAvg, dBAvg };
}

function reasonFor(chans, level) {
  if (level === "NORMAL") return "Back within limits";
  const hit = Object.keys(chans).filter(c => chans[c] === level);
  const names = { UV: "UV index", MAGNETIC: "field change", GAMMA: "gamma threat", FLARE: "flare index" };
  return hit.map(c => names[c]).join(" + ") + " at " + level.toLowerCase() + " level";
}

function addLog(time, from, to, reason) {
  logRows.unshift({ time, from, to, reason });
  logRows = logRows.slice(0, 6);
}

/* One reading in, whatever its origin: update series, level, log, simulated LoRa, then draw. */
function process(s, src, missingPayload, t) {
  series.push({ t, src, missing: missingPayload, ...s });
  if (series.length > N) series.shift();
  k++;
  const ev = evaluate(s);
  const cur = series[series.length - 1];
  Object.assign(cur, { level: ev.level, chans: ev.chans, cpmAvg: ev.cpmAvg, dBAvg: ev.dBAvg });

  if (ev.level !== prevLevel) {
    if (ev.level === "ALERT") alerts++;
    addLog(hms(t), prevLevel, ev.level, reasonFor(ev.chans, ev.level));
    prevLevel = ev.level;
  }
  // LoRa: send on entering WARNING or ALERT, then every 10 s while non-normal (simulated, no radio)
  const nowMs = Date.now();
  if (ev.level !== "NORMAL" && (ev.level !== lastSentLevel || nowMs - lastLoraAtMs >= 10000)) {
    loraSeq++; loraN++; lastLoraAtMs = nowMs;
    lastLora = {
      node: "FALCONEYE-HS", seq: loraSeq, link: "LoRa (simulated)", t: hms(t),
      level: ev.level,
      sources: Object.keys(ev.chans).filter(c => ev.chans[c] !== "NORMAL"),
      uv: +s.uv.toFixed(1), field_uT: +ev.dBAvg.toFixed(1), gamma_cpm: +ev.cpmAvg.toFixed(0), flare: +s.flare.toFixed(0),
      data_source: src
    };
    lastSentLevel = ev.level;
  }
  if (ev.level === "NORMAL") lastSentLevel = "NORMAL";
  render(cur);
}

function simTick() { process(sample(k), "SIM", [], new Date()); }

/* Take one raw object from a feed. Returns true if it was a new, usable reading. */
function ingestOne(o, dedupe) {
  const n = normalize(o);
  if (!n) return false;
  if (dedupe && n.key !== null && n.key === feed.lastKey) return false;   // same packet as last poll
  if (n.key !== null) feed.lastKey = n.key;
  feed.lastPktAt = Date.now();
  feed.count++;
  process(n.s, n.src, n.missingPayload, new Date());
  return true;
}
const asList = v => Array.isArray(v) ? v : (v && Array.isArray(v.readings) ? v.readings : [v]);

/* ---- Polling a feed URL ---- */
async function poll() {
  if (pollBusy || !feed.url) return;
  pollBusy = true;
  try {
    const r = await fetch(feed.url, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    feed.lastErr = "";
    const list = asList(data);
    ingestOne(list[list.length - 1], true);      // polling: newest reading only
  } catch (e) {
    const m = e && e.message;
    feed.lastErr = e && e.name === "SyntaxError" ? "reply is not valid JSON"
      : (m === "Failed to fetch" || m === "Load failed" ? "network error or CORS blocked" : String(m || e));
  } finally {
    pollBusy = false;
    updateFeedState();
  }
}
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
function startPolling() {
  stopPolling();
  feed.manual = false;
  poll();
  pollTimer = setInterval(poll, feed.every * 1000);
}

/* ---- Drawing helpers ---- */
function chart(svgId, get, o) {
  const el = document.getElementById(svgId);
  const W = el.clientWidth || 600, H = el.clientHeight || 170, L = 40, R = 10, T = 8, B = 20;
  el.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const x = j => L + (j / (N - 1)) * (W - L - R);
  const y = v => T + (1 - (v - o.min) / (o.max - o.min)) * (H - T - B);
  let g = "";
  o.ticks.forEach(v => {
    g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${C.grid}" stroke-width="1"/>`;
    g += `<text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
  });
  (o.bands || []).forEach(b => {
    const y1 = y(b.hi), y2 = y(b.lo);
    g += `<rect x="${L}" y="${y1}" width="${W - L - R}" height="${y2 - y1}" fill="${b.color}" fill-opacity="${b.alpha}"/>`;
  });
  (o.lines || []).forEach(l => {
    g += `<line x1="${L}" x2="${W - R}" y1="${y(l.v)}" y2="${y(l.v)}" stroke="${l.color}" stroke-width="1.2" stroke-dasharray="5 4"/>`;
    g += `<text x="${W - R}" y="${y(l.v) - 4}" text-anchor="end" style="fill:${l.color}">${l.label}</text>`;
  });
  const off = N - series.length;
  let pts = "";
  series.forEach((p, j) => { pts += `${x(off + j).toFixed(1)},${y(get(p)).toFixed(1)} `; });
  let dot = "";
  if (series.length) {
    const last = series[series.length - 1];
    dot = `<circle cx="${x(N - 1)}" cy="${y(get(last))}" r="4" fill="${o.color}"/>`;
  }
  g += `<polyline points="${pts}" fill="none" stroke="${o.color}" stroke-width="2" stroke-linejoin="round"/>${dot}`;
  if (series.length > 1 && x(off) < W - R - 70) {      // skip the left label when it would crowd "now"
    const span = Math.round((Date.now() - series[0].t) / 1000);
    const lbl = span >= 90 ? "−" + Math.round(span / 60) + " min" : "−" + span + " s";
    g += `<text x="${x(off)}" y="${H - 5}">${lbl}</text>`;
  }
  g += `<text x="${W - R}" y="${H - 5}" text-anchor="end">now</text>`;
  el.innerHTML = g;
}

/* Half-circle gauge in a 120 × 66 box: radius 42 keeps the arc and its caps inside the box. */
function gauge(svgId, v, min, max, color, bands) {
  const cx = 60, cy = 56, r = 42;
  const empty = v === null || v === undefined;       // no reading yet: draw the empty track only
  const f = empty ? 0 : Math.max(0, Math.min(1, (v - min) / (max - min)));
  const pt = fr => { const a = Math.PI - fr * Math.PI; return [cx + r * Math.cos(a), cy - r * Math.sin(a)]; };
  const arc = (f0, f1) => {
    const [x0, y0] = pt(f0), [x1, y1] = pt(f1);
    // A gauge arc spans at most 180 degrees, so the large-arc flag is always 0.
    return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  };
  let s = `<path d="${arc(0, 1)}" fill="none" stroke="${C.grid}" stroke-width="7" stroke-linecap="round"/>`;
  (bands || []).forEach(b => {
    s += `<path d="${arc(b.f0, b.f1)}" fill="none" stroke="${b.color}" stroke-opacity="0.35" stroke-width="7"/>`;
  });
  if (f > 0) s += `<path d="${arc(0, f)}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round"/>`;
  if (!empty) {
    const [nx, ny] = pt(f);
    s += `<circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="3.5" fill="${color}"/>`;
  }
  document.getElementById(svgId).innerHTML = s;
}

/* Globe and orbit: simulated, drawn each animation frame. */
const gcv = document.getElementById("globe");
const gctx = gcv.getContext("2d");
const UAE = { lat: 25.2, lon: 55.3 };
const INC = 51 * Math.PI / 180;

function drawGlobe(now) {
  const dpr = window.devicePixelRatio || 1;
  const w = gcv.clientWidth, h = gcv.clientHeight;
  if (!w || !h) return requestAnimationFrame(drawGlobe);
  if (gcv.width !== Math.round(w * dpr)) { gcv.width = Math.round(w * dpr); gcv.height = Math.round(h * dpr); }
  const g = gctx;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.4;
  const rot = now * 0.00004;

  const atm = g.createRadialGradient(cx, cy, R * 0.95, cx, cy, R * 1.25);
  atm.addColorStop(0, "rgba(95,211,224,0.22)"); atm.addColorStop(1, "rgba(95,211,224,0)");
  g.fillStyle = atm; g.beginPath(); g.arc(cx, cy, R * 1.25, 0, Math.PI * 2); g.fill();
  const body = g.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
  body.addColorStop(0, "#14303b"); body.addColorStop(1, "#060c10");
  g.fillStyle = body; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();

  const proj = (lat, lon) => {
    const a = lon - rot;
    return [cx + R * Math.cos(lat) * Math.sin(a), cy - R * Math.sin(lat), Math.cos(lat) * Math.cos(a)];
  };
  g.lineWidth = 1; g.strokeStyle = "rgba(122,167,255,0.22)";
  for (let lat = -60; lat <= 60; lat += 30) {
    g.beginPath(); let pen = false;
    for (let lon = 0; lon <= 360; lon += 4) {
      const [x, y, z] = proj(lat * Math.PI / 180, lon * Math.PI / 180);
      if (z > 0) { pen ? g.lineTo(x, y) : g.moveTo(x, y); pen = true; } else pen = false;
    }
    g.stroke();
  }
  for (let lon = 0; lon < 360; lon += 30) {
    g.beginPath(); let pen = false;
    for (let lat = -90; lat <= 90; lat += 4) {
      const [x, y, z] = proj(lat * Math.PI / 180, lon * Math.PI / 180);
      if (z > 0) { pen ? g.lineTo(x, y) : g.moveTo(x, y); pen = true; } else pen = false;
    }
    g.stroke();
  }

  const Rs = R * 1.15;
  const orbitPt = th => {
    const px = Math.cos(th), py = Math.sin(th) * Math.cos(INC), pz = Math.sin(th) * Math.sin(INC);
    return [cx + Rs * px, cy - Rs * py, pz];
  };
  g.strokeStyle = "rgba(242,169,59,0.45)"; g.setLineDash([4, 5]); g.beginPath();
  for (let j = 0; j <= 120; j++) { const [x, y] = orbitPt(j / 120 * Math.PI * 2); j ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.stroke(); g.setLineDash([]);

  const [ux, uy, uz] = proj(UAE.lat * Math.PI / 180, UAE.lon * Math.PI / 180);
  if (uz > 0) {
    g.fillStyle = C.amber; g.beginPath(); g.arc(ux, uy, 4, 0, Math.PI * 2); g.fill();
    g.fillStyle = C.mute; g.font = "10px 'IBM Plex Mono', monospace"; g.fillText("UAE GS (SIM)", ux + 7, uy + 4);
  }

  const th = (((Date.now() - modeStart) / 1000) * 0.045) % (Math.PI * 2);
  const [sx, sy, sz] = orbitPt(th);
  trail.push([sx, sy]); if (trail.length > 50) trail.shift();
  g.strokeStyle = "rgba(228,236,241,0.35)"; g.lineWidth = 2; g.beginPath();
  trail.forEach((p, j) => (j ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
  g.stroke(); g.lineWidth = 1;

  const cur = series[series.length - 1];
  const col = cur ? LEVEL_COLOR[cur.level] : C.ok;
  const strength = cur ? Math.min(1, 0.3 + Math.max(cur.uv / 12, cur.dBAvg / 15, cur.flare / 100)) : 0.3;
  const glow = g.createRadialGradient(sx, sy, 0, sx, sy, 24);
  glow.addColorStop(0, col + "99"); glow.addColorStop(1, col + "00");
  g.globalAlpha = 0.4 + 0.6 * strength;
  g.fillStyle = glow; g.beginPath(); g.arc(sx, sy, 24, 0, Math.PI * 2); g.fill();
  g.globalAlpha = 1;
  g.fillStyle = sz > 0 ? "#e4ecf1" : "#8a9ca8"; g.beginPath(); g.arc(sx, sy, 4, 0, Math.PI * 2); g.fill();
  g.fillStyle = C.mute; g.font = "10px 'IBM Plex Mono', monospace"; g.fillText("SAT (SIM)", sx + 7, sy - 6);
  requestAnimationFrame(drawGlobe);
}

/* ---- Rendering ---- */
function chanLabel(v) { return v === "ALERT" ? "ALERT" : v === "WARNING" ? "WARNING" : "NORMAL"; }

function setBadges(label, cls, headerText) {
  document.querySelectorAll("[data-src]").forEach(el => { el.textContent = label; el.className = "badge " + cls; });
  const b = $("srcBadge");
  b.textContent = headerText;
  b.className = "badge " + (cls === "live" ? "live" : "sim");
}

/* Parts shared by the normal and the empty (no data yet) states. */
function renderCommon() {
  chart("uvChart", p => p.uv, {
    min: 0, max: 12, ticks: [0, 3, 6, 8, 11], color: C.amber,
    bands: [
      { lo: 0, hi: 3, color: C.ok, alpha: 0.06 }, { lo: 3, hi: 6, color: C.warn, alpha: 0.06 },
      { lo: 6, hi: 8, color: C.amber, alpha: 0.08 }, { lo: 8, hi: 11, color: C.alert, alpha: 0.08 }
    ],
    lines: [{ v: UV_WARN, color: C.alert, label: "WARNING 8" }]
  });
  chart("magChart", p => p.dBAvg ?? p.dB, {
    min: 0, max: 15, ticks: [0, 5, 10, 15], color: C.rad,
    bands: [{ lo: MAG_WARN, hi: MAG_ALERT, color: C.warn, alpha: 0.08 }, { lo: MAG_ALERT, hi: 15, color: C.alert, alpha: 0.08 }],
    lines: [{ v: MAG_WARN, color: C.warn, label: "WARNING 5" }, { v: MAG_ALERT, color: C.alert, label: "ALERT 10" }]
  });

  $("tl").innerHTML = series.map(p => `<span class="${p.level}" title="${p.level}"></span>`).join("");

  const gs = $("gs"), note = $("gsNote");
  if (!lastLora) {
    gs.innerHTML = '<span class="dim">$ await event</span>\n<span class="ok">NORMAL</span>: nothing to send';
    note.textContent = "Packets are sent only on WARNING or ALERT, and every 10 s while one is active.";
  } else {
    const cls = lastLora.level === "ALERT" ? "al" : "wa";
    const txt = JSON.stringify(lastLora, null, 2).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    gs.innerHTML = `<span class="dim">$ lora send --to ground-control --simulated</span>\n<span class="${cls}">${lastLora.level} · packet ${lastLora.seq} sent (simulated)</span>\n` + txt;
    note.textContent = "Simulated LoRa link. The prototype has no radio, so nothing is transmitted.";
  }

  $("logBody").innerHTML = logRows.length
    ? logRows.map(r => `<tr><td class="t">${r.time}</td><td><span class="tag ${r.from}">${r.from}</span> → <span class="tag ${r.to}">${r.to}</span></td><td>${r.reason}</td></tr>`).join("")
    : `<tr><td colspan="3" class="mute">No events yet.</td></tr>`;
}

function render(cur) {
  const L = cur.level;
  $("banner").dataset.lvl = L;
  $("lvl").textContent = L;

  const heads = {
    NORMAL: ["Environment within limits", "UV, magnetic field and threat inputs below warning levels."],
    WARNING: ["Warning: a channel is above its warning level", "Alert not yet raised. Ground control is kept informed over LoRa (simulated)."],
    ALERT: ["Alert: a channel is above its alert level", "Hazard alert sent to ground control over LoRa (simulated)."]
  };
  $("bannerText").textContent = heads[L][0];
  $("bannerSub").textContent = heads[L][1] + (cur.missing.length
    ? " Missing from packet: " + cur.missing.join(", ") + " (carried forward, shown as SIM)." : "");
  $("alertN").textContent = alerts;
  $("loraN").textContent = loraN;
  $("pkt").textContent = hms(cur.t);

  const live = cur.src === "LIVE";
  setBadges(live ? "LIVE" : "SIM", live ? "live" : "sim",
    live ? "LIVE DATA" : (mode === "sim" ? "SIMULATED" : "SIMULATED DATA"));

  $("gUVv").textContent = cur.uv.toFixed(1);
  $("gMagv").textContent = cur.dBAvg.toFixed(1);
  $("gTempv").textContent = cur.temp.toFixed(1);
  $("uvNote").textContent = `UV ${cur.uv.toFixed(1)}: ${cur.uv >= UV_WARN ? "at or above the WARNING level of 8" : "below the WARNING level of 8"}.`;
  $("magNote").textContent = `Field change ${cur.dBAvg.toFixed(1)} µT (5-point average): ${cur.dBAvg > MAG_ALERT ? "above ALERT 10" : cur.dBAvg > MAG_WARN ? "above WARNING 5" : "within normal range"}.`;
  $("tempNote").textContent = cur.temp >= 0 && cur.temp <= 40 ? "Housekeeping. Within the 0 to 40 °C band." : "Housekeeping. Outside the 0 to 40 °C band.";

  gauge("gUV", cur.uv, 0, 12, C.amber, [
    { f0: 0, f1: 3 / 12, color: C.ok }, { f0: 3 / 12, f1: 8 / 12, color: C.warn }, { f0: 8 / 12, f1: 1, color: C.alert }
  ]);
  gauge("gMag", cur.dBAvg, 0, 15, C.rad, [
    { f0: 0, f1: MAG_WARN / 15, color: C.ok }, { f0: MAG_WARN / 15, f1: MAG_ALERT / 15, color: C.warn }, { f0: MAG_ALERT / 15, f1: 1, color: C.alert }
  ]);
  gauge("gTemp", cur.temp, 0, 40, C.ok, [{ f0: 0, f1: 1, color: C.ok }]);

  $("threatList").innerHTML = [
    ["Gamma threat (CPM, 5-pt avg)", cur.cpmAvg.toFixed(0)],
    ["Flare index (0 to 100)", cur.flare.toFixed(0)],
    ["Gamma level", chanLabel(cur.chans.GAMMA)],
    ["Flare level", chanLabel(cur.chans.FLARE)]
  ].map(([a, b]) => `<dt>${a}</dt><dd class="mono">${b}</dd>`).join("");

  $("chanList").innerHTML = [
    ["UV channel", chanLabel(cur.chans.UV)],
    ["Magnetometer channel", chanLabel(cur.chans.MAGNETIC)],
    ["Gamma threat channel", chanLabel(cur.chans.GAMMA)],
    ["Flare channel", chanLabel(cur.chans.FLARE)],
    ["Ground link", "LoRa, simulated"]
  ].map(([a, b]) => `<dt>${a}</dt><dd class="mono">${b}</dd>`).join("");

  renderCommon();
  updateFeedState();
}

/* Live mode, before the first reading: show nothing instead of made-up numbers. */
function renderEmpty() {
  $("banner").dataset.lvl = "NODATA";
  $("lvl").textContent = "NO DATA";
  $("bannerText").textContent = "Waiting for live data";
  $("bannerSub").textContent = "Connect a feed URL or paste a JSON packet. No values are shown until a reading arrives.";
  $("alertN").textContent = "0";
  $("loraN").textContent = "0";
  $("pkt").textContent = "–";
  setBadges("WAITING", "sim", "NO DATA YET");
  ["gUVv", "gMagv", "gTempv"].forEach(id => { $(id).textContent = "–"; });
  $("uvNote").textContent = "–";
  $("magNote").textContent = "–";
  $("tempNote").textContent = "Housekeeping. Operating band 0 to 40 °C.";
  gauge("gUV", null, 0, 12, C.amber, []);
  gauge("gMag", null, 0, 15, C.rad, []);
  gauge("gTemp", null, 0, 40, C.ok, []);
  const dash = ["Gamma threat (CPM, 5-pt avg)", "Flare index (0 to 100)", "Gamma level", "Flare level"];
  $("threatList").innerHTML = dash.map(a => `<dt>${a}</dt><dd class="mono">–</dd>`).join("");
  const chs = ["UV channel", "Magnetometer channel", "Gamma threat channel", "Flare channel"];
  $("chanList").innerHTML = chs.map(a => `<dt>${a}</dt><dd class="mono">–</dd>`).join("")
    + `<dt>Ground link</dt><dd class="mono">LoRa, simulated</dd>`;
  renderCommon();
}

/* Data-source readout in the status strip; runs every second so ages and MET keep moving. */
function updateFeedState() {
  const el = $("feedState");
  $("met").textContent = met(Math.floor((Date.now() - modeStart) / 1000));
  const last = series[series.length - 1];
  let text, cls, title = "";
  if (mode === "sim") {
    text = "SIM"; cls = "sim"; title = "Built-in simulation";
  } else if (feed.manual && !pollTimer) {
    text = last ? "PASTED · " + last.src : "WAITING";
    cls = last && last.src === "LIVE" ? "live" : (last ? "sim" : "stale");
    title = "Readings pasted into the page";
  } else if (!feed.count) {
    text = feed.lastErr ? "ERROR" : "WAITING";
    cls = feed.lastErr ? "err" : "stale";
    title = feed.lastErr || "Waiting for the first reading";
    $("bannerSub").textContent = feed.lastErr
      ? "Cannot read the feed: " + feed.lastErr + ". Check the URL, that it returns JSON, and that it allows cross-origin reads."
      : "Connected. Waiting for the first reading from the feed.";
  } else {
    const age = Math.round((Date.now() - feed.lastPktAt) / 1000);
    const staleAfter = Math.max(10, feed.every * 3);
    if (feed.lastErr) { text = "ERROR · " + age + "s"; cls = "err"; title = feed.lastErr; }
    else if (age > staleAfter) { text = "STALE · " + age + "s"; cls = "stale"; title = "No new reading from the feed"; }
    else { text = last.src + " · " + age + "s ago"; cls = last.src === "LIVE" ? "live" : "sim"; }
  }
  el.textContent = text;
  el.className = "v " + cls;
  el.title = title;
}

/* ---- Modes ---- */
function resetState() {
  series = []; k = 0; prevLevel = "NORMAL"; alerts = 0; loraN = 0; loraSeq = 0; lastLora = null;
  lastLoraAtMs = 0; lastSentLevel = "NORMAL"; trail = []; logRows = [];
  modeStart = Date.now();
  feed.lastKey = null; feed.lastPktAt = 0; feed.count = 0; feed.lastErr = ""; feed.manual = false;
}

function connectFeed() {
  const url = $("feedUrl").value.trim();
  feed.url = url;
  feed.every = Math.max(1, Math.min(60, Number($("interval").value) || 2));
  try { localStorage.setItem("falconeye.feedUrl", url); localStorage.setItem("falconeye.interval", String(feed.every)); } catch (e) { /* storage unavailable */ }
  if (!url) { feed.lastErr = "enter a feed URL"; updateFeedState(); return; }
  startPolling();
}

function setMode(m, opts = {}) {
  mode = m;
  stopPolling();
  clearInterval(simTimer); simTimer = null;
  resetState();
  $("mode").value = m;
  $("simCtl").hidden = m !== "sim";
  $("liveCtl").hidden = m !== "live";
  if (m === "sim") {
    addLog(hms(new Date()), "–", "NORMAL", "Event started: " + EVENT_NAMES[scen]);
    simTick();
    simTimer = setInterval(simTick, 1000);
  } else {
    addLog(hms(new Date()), "–", "NORMAL", "Live feed selected");
    renderEmpty();
    if (opts.poll !== false) connectFeed();
  }
  updateFeedState();
}

/* ---- Pasted JSON: one packet, an array, {"readings":[...]}, or one packet per line ---- */
function parseLoose(text) {
  text = text.trim();
  if (!text) return [];
  try { return asList(JSON.parse(text)); } catch (e) { /* try line by line */ }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    try { out.push(...asList(JSON.parse(l))); }
    catch (e) { throw new Error("Could not read this line as JSON: " + l.slice(0, 50)); }
  }
  return out;
}

/* ---- Events ---- */
$("mode").addEventListener("change", e => setMode(e.target.value));
$("scen").addEventListener("change", e => { scen = e.target.value; setMode("sim"); });
$("connect").addEventListener("click", () => setMode("live"));
$("feedUrl").addEventListener("keydown", e => { if (e.key === "Enter") setMode("live"); });
$("pasteBtn").addEventListener("click", () => { $("pasteMsg").textContent = ""; $("pasteDlg").showModal(); });
$("pasteCancel").addEventListener("click", () => $("pasteDlg").close());
$("pasteApply").addEventListener("click", () => {
  const msg = $("pasteMsg");
  const bad = t => { msg.textContent = t; msg.className = "msg bad"; };
  let items;
  try { items = parseLoose($("pasteText").value); } catch (e) { return bad(e.message); }
  if (!items.length) return bad("Nothing to apply. Paste at least one JSON packet.");
  if (mode !== "live") setMode("live", { poll: false });
  feed.manual = !pollTimer;
  let ok = 0;
  items.forEach(o => { if (ingestOne(o, false)) ok++; });
  if (!ok) return bad("No readings found. A packet needs uv_index, field_delta_uT or temp_C.");
  msg.textContent = "Applied " + ok + " packet" + (ok === 1 ? "" : "s") + ".";
  msg.className = "msg";
  $("pasteDlg").close();
});

/* ---- Start ---- */
(function init() {
  const q = new URLSearchParams(location.search);
  try {
    const u = localStorage.getItem("falconeye.feedUrl"), i = localStorage.getItem("falconeye.interval");
    if (u) $("feedUrl").value = u;
    if (i) $("interval").value = i;
  } catch (e) { /* storage unavailable */ }
  if (q.get("feed")) $("feedUrl").value = q.get("feed");
  if (q.get("interval")) $("interval").value = q.get("interval");
  if (EVENT_NAMES[q.get("event")]) scen = q.get("event");
  $("scen").value = scen;
  setMode(q.get("feed") || q.get("mode") === "live" ? "live" : "sim");
  setInterval(updateFeedState, 1000);
  requestAnimationFrame(drawGlobe);
})();
