// TFM Site Alerts relay — receives an alert from a TFM site and creates a ClickUp task.
//
// Env vars (set in Vercel project settings):
//   CLICKUP_TOKEN    – ClickUp personal API token (kept server-side; never on sites)
//   CLICKUP_LIST_ID  – ID of the central "Site Alerts" ClickUp list
//   ALLOWED_DOMAINS  – (optional) comma-separated domains allowed to send alerts,
//                      e.g. "tfmstaging.com,topfiremedia.com". If unset, all are accepted.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { CLICKUP_TOKEN, CLICKUP_LIST_ID, ALLOWED_DOMAINS } = process.env;
  if (!CLICKUP_TOKEN || !CLICKUP_LIST_ID) {
    return res.status(500).json({ error: 'Relay not configured (missing ClickUp env vars)' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const { site_name, site_url, action, severity, user, user_login, context, ip, timestamp, data } = body;
  if (!action || !site_url) {
    return res.status(400).json({ error: 'Missing required fields (action, site_url)' });
  }

  // Authenticate by domain allowlist (no shared secret needed on the sites).
  if (ALLOWED_DOMAINS) {
    const allowed = ALLOWED_DOMAINS.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
    let host = '';
    try { host = new URL(site_url).host.toLowerCase().replace(/:\d+$/, ''); } catch {}
    const ok = allowed.some(d => host === d || host.endsWith('.' + d));
    if (!ok) return res.status(403).json({ error: 'Site not in allowlist', host });
  }

  const emoji = severity === 'danger' ? '🔴' : severity === 'warning' ? '🟠' : '🔵';
  const title = `${emoji} ${pretty(action)} — ${site_name || hostOf(site_url)}`;

  const details = data && typeof data === 'object' && Object.keys(data).length
    ? '\n\n**Details:**\n' + Object.entries(data)
        .map(([k, v]) => `- **${k}:** ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n')
    : '';

  const description =
    `**Site:** ${site_name || ''} (${site_url})\n` +
    `**Event:** ${action} (${severity || 'info'})\n` +
    `**User:** ${user || 'unknown'}${user_login ? ` (${user_login})` : ''}${context ? ` · ${context}` : ''}\n` +
    `**IP:** ${ip || 'n/a'}\n` +
    `**When:** ${timestamp || ''}` + details;

  try {
    const r = await fetch(`https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/task`, {
      method: 'POST',
      headers: { Authorization: CLICKUP_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: title, markdown_description: description, tags: [hostOf(site_url)] }),
    });
    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: 'ClickUp API error', status: r.status, detail: t.slice(0, 400) });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(502).json({ error: 'Forward failed', detail: String(e).slice(0, 300) });
  }
}

function pretty(a) { return String(a).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }
function hostOf(u) { try { return new URL(u).host.replace(/:\d+$/, ''); } catch { return 'site'; } }
