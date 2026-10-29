/* Vercel serverless function: POST a reading, GET the latest one.
 *
 *   POST /api/telemetry   body: one JSON packet (see README), header x-api-key if INGEST_KEY is set
 *   GET  /api/telemetry   returns the latest packet
 *
 * The latest packet is kept in this instance's memory. That is fine for a single-user demo,
 * but serverless memory is not guaranteed to persist: if readings vanish, swap the two
 * `latest` lines for Vercel KV or Upstash Redis.
 */
const crypto = require("crypto");

const NUMERIC = [
  "uv_index", "uv", "uvIndex",
  "field_delta_uT", "field_uT", "field_delta", "dB",
  "temp_C", "temp", "temperature",
  "gamma_cpm", "cpm", "gamma",
  "flare_index", "flare"
];

let latest = null;
let counter = 0;

function sameKey(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

module.exports = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

  if (req.method === "GET") {
    return send(res, 200, latest || { status: "no data yet" });
  }

  if (req.method === "POST") {
    const need = process.env.INGEST_KEY;
    if (need && !sameKey(req.headers["x-api-key"], need)) return send(res, 401, { error: "missing or wrong x-api-key" });

    let body = req.body;
    if (Buffer.isBuffer(body)) body = body.toString("utf8");
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { return send(res, 400, { error: "body is not valid JSON" }); } }
    if (Array.isArray(body)) body = body[body.length - 1];
    if (!body || typeof body !== "object") return send(res, 400, { error: "send one JSON object" });

    // Keep only the fields the dashboard understands.
    const clean = {};
    let numeric = 0;
    for (const key of NUMERIC) {
      if (body[key] === undefined || body[key] === null || body[key] === "") continue;
      const v = Number(body[key]);
      if (Number.isFinite(v)) { clean[key] = v; numeric++; }
    }
    if (!numeric) return send(res, 400, { error: "no numeric readings found (need uv_index, field_delta_uT or temp_C)" });

    clean.source = String(body.source || "").toUpperCase() === "LIVE" ? "LIVE" : "SIM";
    clean.seq = Number.isFinite(Number(body.seq)) ? Number(body.seq) : ++counter;
    if (typeof body.t === "string" && body.t.length <= 40) clean.t = body.t;
    clean.received_at = new Date().toISOString();
    latest = clean;
    return send(res, 200, { ok: true, seq: clean.seq });
  }

  res.setHeader("Allow", "GET, POST, OPTIONS");
  return send(res, 405, { error: "method not allowed" });
};
