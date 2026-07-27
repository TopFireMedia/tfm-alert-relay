import { createClickUpTask, hostOf, pretty } from '../lib/clickup.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const { site_name, site_url, action, severity, user, user_login, context, ip, timestamp, data } = body;
  if (!action || !site_url) return res.status(400).json({ error: 'Missing required fields (action, site_url)' });

  // Muted actions never create a ClickUp task — too noisy to be useful. Failed
  // logins in particular are constant automated bot traffic on every WordPress
  // site. Configurable via the MUTED_ACTIONS env var (comma-separated).
  const MUTED = new Set(
    (process.env.MUTED_ACTIONS || 'user_login_failed').split(',').map(s => s.trim()).filter(Boolean)
  );
  if (MUTED.has(action)) return res.status(200).json({ ok: true, muted: action });

  if (process.env.ALLOWED_DOMAINS) {
    const allowed = process.env.ALLOWED_DOMAINS.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
    const host = hostOf(site_url).toLowerCase();
    if (!allowed.some(d => host === d || host.endsWith('.' + d))) {
      return res.status(403).json({ error: 'Site not in allowlist', host });
    }
  }

  const emoji = severity === 'danger' ? '🔴' : severity === 'warning' ? '🟠' : '🔵';
  const title = `${emoji} ${pretty(action)} — ${site_name || hostOf(site_url)}`;
  const details = data && typeof data === 'object' && Object.keys(data).length
    ? '\n\n**Details:**\n' + Object.entries(data).map(([k, v]) => `- **${k}:** ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n')
    : '';
  const description =
    `**Site:** ${site_name || ''} (${site_url})\n` +
    `**Event:** ${action} (${severity || 'info'})\n` +
    `**User:** ${user || 'unknown'}${user_login ? ` (${user_login})` : ''}${context ? ` · ${context}` : ''}\n` +
    `**IP:** ${ip || 'n/a'}\n**When:** ${timestamp || ''}` + details;

  try {
    await createClickUpTask({ title, description, tags: [hostOf(site_url)] });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(502).json({ error: 'Forward failed', detail: String(e).slice(0, 300) });
  }
}
