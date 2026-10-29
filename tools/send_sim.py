#!/usr/bin/env python3
"""Send readings to the dashboard's /api/telemetry endpoint. No dependencies except pyserial for --serial.

Examples
  # Test the whole chain with simulated readings (tagged SIM)
  python3 tools/send_sim.py --url https://YOUR-APP.vercel.app/api/telemetry --event magnetic

  # Replay readings you copied out of Tinkercad's serial monitor (one JSON object per line)
  python3 tools/send_sim.py --url https://YOUR-APP.vercel.app/api/telemetry --file readings.jsonl

  # Real hardware later: Arduino/ESP32 prints one JSON line per reading over USB (tagged LIVE)
  python3 tools/send_sim.py --url https://YOUR-APP.vercel.app/api/telemetry --serial COM3 --source LIVE

If you set INGEST_KEY in Vercel, pass it with --key (or the INGEST_KEY environment variable).
"""
import argparse, json, math, os, random, sys, time, urllib.request, urllib.error

BASE_CPM = 18
SIG = math.sqrt(BASE_CPM)


def bump(x, a, b, c, d):
    if x <= a or x >= d:
        return 0.0
    if x < b:
        return (x - a) / (b - a)
    if x <= c:
        return 1.0
    return (d - x) / (d - c)


def gauss():
    return (random.random() + random.random() + random.random() - 1.5) * 2


def simulated(n, event):
    ph = n % 200
    uv = 4 + 1.2 * math.sin(n / 30) + 0.2 * gauss()
    db = 0.4 * gauss()
    cpm = BASE_CPM + SIG * gauss()
    flare = 15 + 3 * gauss()
    if event == "solar":
        b = bump(ph, 8, 12, 60, 70)
        cpm += 42 * b
        flare += 70 * b
    elif event == "magnetic":
        db += 14 * bump(ph, 8, 14, 60, 70)
    elif event == "uv":
        uv += 5.2 * bump(ph, 6, 10, 40, 50)
    return {
        "uv_index": round(max(0, uv), 2),
        "field_delta_uT": round(abs(db), 2),
        "temp_C": round(27 + 2 * math.sin(n / 50) + 0.2 * gauss(), 1),
        "gamma_cpm": round(max(0, cpm)),
        "flare_index": round(max(0, min(100, flare))),
    }


def post(url, key, packet):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["x-api-key"] = key
    req = urllib.request.Request(url, data=json.dumps(packet).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", required=True, help="the /api/telemetry address of your deployed dashboard")
    ap.add_argument("--key", default=os.environ.get("INGEST_KEY", ""), help="x-api-key, if INGEST_KEY is set on the server")
    ap.add_argument("--source", default="SIM", choices=["SIM", "LIVE"], help="label for the data (default SIM)")
    ap.add_argument("--event", default="solar", choices=["none", "solar", "magnetic", "uv"], help="simulated event")
    ap.add_argument("--rate", type=float, default=1.0, help="seconds between packets")
    ap.add_argument("--file", help="replay JSON lines from this file")
    ap.add_argument("--serial", help="read JSON lines from this serial port, e.g. COM3 or /dev/ttyUSB0")
    ap.add_argument("--baud", type=int, default=9600)
    a = ap.parse_args()

    def send(packet):
        packet.setdefault("source", a.source)
        packet.setdefault("t", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
        try:
            status = post(a.url, a.key, packet)
            print("sent", status, json.dumps(packet))
        except urllib.error.HTTPError as e:
            print("server said", e.code, e.read().decode()[:200])
        except Exception as e:
            print("failed:", e)

    if a.file:
        with open(a.file, encoding="utf8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    send(json.loads(line))
                except json.JSONDecodeError:
                    print("skipped (not JSON):", line[:60])
                time.sleep(a.rate)
        return

    if a.serial:
        try:
            import serial  # pip install pyserial
        except ImportError:
            sys.exit("pyserial is needed for --serial: pip install pyserial")
        port = serial.Serial(a.serial, a.baud, timeout=2)
        print("reading", a.serial, "at", a.baud, "baud; Ctrl+C to stop")
        while True:
            line = port.readline().decode("utf8", "ignore").strip()
            if not line:
                continue
            try:
                send(json.loads(line))
            except json.JSONDecodeError:
                print("skipped (not JSON):", line[:60])

    n = 0
    print("sending simulated readings (" + a.source + ", event=" + a.event + "); Ctrl+C to stop")
    while True:
        send(simulated(n, a.event))
        n += 1
        time.sleep(a.rate)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
