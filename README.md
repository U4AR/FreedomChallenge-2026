# Freedom Challenge — India Independence Day 2026

A server-authoritative 15-question Socket.IO quiz for one host and up to 150 players. The Node server is the source of truth for timing, answer eligibility, and scoring.

## Local

```bash
npm install
npm start
```

Open the printed host URL. Phones on the same Wi-Fi scan its QR code and enter only a nickname; this single-game deployment does not use a public game PIN. Set `HOST_TOKEN` to keep the host URL stable across restarts.

## Render

Create a new **Web Service** from this repository (or use `render.yaml`). Build command: `npm install`; start command: `npm start`; health check: `/health`. Add `HOST_TOKEN` as a secret and set `ALLOWED_ORIGINS` to the comma-separated Sites and Render origins. Render supplies `PORT` automatically. The standalone player page is `/join`; host is `/host?token=YOUR_SECRET`.

In ChatGPT Sites set:

```text
REALTIME_SERVER_URL=https://your-service.onrender.com
```

Use HTTPS/WSS in production. Socket.IO prefers WebSocket and falls back only when necessary.

## Load test

With a fresh server running as `HOST_TOKEN=load-test-secret npm start`:

```bash
HOST_TOKEN=load-test-secret npm run load-test
```

Edit `quiz.json` to change questions. Keep exactly one `correctIndex` (0–3) per question.
