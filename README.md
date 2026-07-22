# TFM Alert Relay + Fleet Monitor

Backend for the TFM Custom Functions plugin fleet (~50 WordPress sites).

## Endpoints
- `POST /api/alert` — critical activity events → ClickUp task.
- `POST /api/heartbeat` — sites check in (self-register + version/health). Sends a "recovered" task if a down site returns.
- `GET  /api/monitor` — cron (every 5 min): flags sites with no heartbeat for 45 min (confirmed by a direct request) → "site down" ClickUp task.
- `GET  /api/fleet?key=TOKEN` — HTML dashboard of every site + plugin/PHP/WP version + last-seen + status. `&format=json` for raw.

## Environment variables (Vercel → Settings → Environment Variables)
- `CLICKUP_TOKEN`, `CLICKUP_LIST_ID` — ClickUp API token + "Site Alerts" list ID.
- `KV_REST_API_URL`, `KV_REST_API_TOKEN` — auto-added when you attach an Upstash/KV store to the project.
- `ALLOWED_DOMAINS` — (optional) comma-separated allowed site domains.
- `DASHBOARD_TOKEN` — (optional) protects `/api/fleet`.

## Storage
Attach an **Upstash (Redis)** store via Vercel → Storage; it injects the `KV_*` env vars automatically.
