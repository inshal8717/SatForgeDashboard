# PRD: FalconEye Helios Shield Live Dashboard (MVP)

**Team:** falconeye · **Owner:** dashboard · **Deadline:** Phase 1 link 30 Oct 2026, 12:00 PM (UAE); live data matters most for Phase 2, 4 Nov.

## 1. Problem
The judges asked for a live, interactive dashboard on a public link (Vercel or Grafana). Our current dashboard is a polished design but runs only on built-in simulated data, and the team has no hardware on the bench yet (everything is in Tinkercad). We need a deployable app that looks the same, keeps working with no data source, and switches to real readings the moment JSON is available.

## 2. Goals
1. Deploy with no build step: `npx vercel --prod` from this folder, or import it from a GitHub repo in Vercel, and get a public URL.
2. Keep the existing design, alert rules, globe, event log and simulated LoRa panel.
3. Accept live JSON from: (a) a URL the page polls, (b) a POST to our own `/api/telemetry` endpoint, (c) JSON pasted into the page (single packet, array, or one packet per line).
4. Never mislabel data: every value shows SIM or LIVE according to the packet's `source` field.

## 3. Users
- **Judges:** open one link, see a working mission dashboard, read the honesty labels.
- **Team:** feed it from a laptop script, an ESP32, or pasted Tinkercad serial output, with no Grafana knowledge.

## 4. Scope
**In (MVP):** the existing panels; Source switch (Simulation or Live feed); feed URL box with poll interval; paste dialog; stale/error indicator; `/api/telemetry` (POST and GET, optional key); sample data; a Python sender; README with deploy steps.

**Out (later):** database persistence, auth for viewers, real LoRa link, reading hardware directly in the browser, multi-satellite views, replacing the simulated globe with real orbit data.

## 5. Data contract (one JSON object per reading)
```json
{
  "source": "LIVE",
  "t": "2026-10-30T07:15:00Z",
  "seq": 42,
  "uv_index": 5.4,
  "field_delta_uT": 2.1,
  "temp_C": 26.8,
  "gamma_cpm": 19,
  "flare_index": 14
}
```
- Required for a meaningful dashboard: `uv_index`, `field_delta_uT`, `temp_C`.
- Optional: `gamma_cpm`, `flare_index` (simulated threat inputs). Any missing field is filled with a SIM baseline and the page says so.
- `source`: `"LIVE"` or `"SIM"`. Missing means SIM.
- `t` or `seq`: optional but recommended; lets the page detect stale feeds and skip duplicates.
- Alternate key names accepted: `uv`, `field_uT`, `dB`, `temp`, `cpm`, `flare`.

## 6. Alert logic (unchanged from the current dashboard)
UV WARNING at 8 or above. Field change (5-point average) WARNING above 5 µT, ALERT above 10 µT. Gamma threat (5-point CPM average) WARNING above 26.5, ALERT above 30.7. Flare index WARNING at 50, ALERT at 80. Overall level is the highest channel level. The magnetic baseline and thresholds are placeholders and stay flagged as such.

## 7. Honesty requirements
- SIM or LIVE badge on payload telemetry and both charts, driven by the packet's `source`.
- Gamma and flare stay labelled as simulated threat inputs; LoRa stays labelled SIMULATED LINK · NO RADIO.
- Orbit globe stays labelled simulated.
- Footer states: 1U CubeSat engineering model, ground-based prototype, not flown.
- No mass, power or link-performance claims.

## 8. Acceptance criteria
1. Opens with Simulation running and the three events (solar, magnetic, UV) reaching the expected levels.
2. Switching to Live feed with no data shows WAITING, not fake values.
3. Pushing a packet with `source: "LIVE"` updates gauges, charts, banner level, log and LoRa panel, and shows LIVE badges.
4. A packet above a threshold raises WARNING or ALERT; the log records the change.
5. A feed that stops updating shows STALE within about 10 s; a failing URL shows an error without crashing.
6. No JS errors; no overflow at 1440×900, 1366×768 and 390 px.
7. `?feed=URL` in the page address starts Live mode automatically, so the submitted link can open on the live feed.

## 9. Risks
- **CORS:** a feed URL on another site must allow cross-origin reads. Our own `/api/telemetry` does.
- **Serverless memory:** `/api/telemetry` keeps the latest reading in memory, which is reliable for a single-user demo but not guaranteed. Swap in Vercel KV or Upstash if it proves flaky.
- **Open ingest:** anyone who knows the URL can POST. Set an `INGEST_KEY` environment variable and send it in the `x-api-key` header.
- **Deadline:** Phase 1 only needs the public link; do not spend the night on hardware plumbing.
