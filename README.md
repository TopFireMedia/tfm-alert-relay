# TFM Alert Relay

Receives critical activity alerts from the TFM Custom Functions plugin and creates
a task in a central ClickUp "Site Alerts" list. The ClickUp token lives here
(server-side) — never on the WordPress sites.

## Deploy (Vercel)
1. Deploy this folder to Vercel.
2. Set Environment Variables:
   - `CLICKUP_TOKEN` – ClickUp personal API token
   - `CLICKUP_LIST_ID` – the "Site Alerts" list ID
   - `ALLOWED_DOMAINS` – e.g. `tfmstaging.com,topfiremedia.com` (optional but recommended)
3. The endpoint is `https://<your-deployment>/api/alert`.
4. In the plugin, set that URL as the default in `includes/clickup-alerts.php`
   (or per-site via `define('TFM_ALERT_RELAY_URL', '…')`).

## Payload (POST /api/alert, JSON)
`{ site_name, site_url, action, severity, user, user_login, context, ip, timestamp, data }`
