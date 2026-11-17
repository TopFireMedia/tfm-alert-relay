import { postAlert, hostOf, pretty } from '../lib/clickup.js';
import { kvGet } from '../lib/kv.js';
import { recordWeekly } from '../lib/buckets.js';
import { hostingCheck } from '../lib/hosts.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const { site_name, site_url, action, severity, user, user_login, context, ip, timestamp, data } = body;
  if (!action || !site_url) return res.status(400).json({ error: 'Missing required fields (action, site_url)' });

  // Muted actions are dropped entirely — too noisy to be worth even counting.
  // Failed logins in particular are constant automated bot traffic on every
  // WordPress site. Configurable via MUTED_ACTIONS (comma-separated).
  const MUTED = new Set(
    (process.env.MUTED_ACTIONS || 'user_login_failed').split(',').map(s => s.trim()).filter(Boolean)
  );
  if (MUTED.has(action)) return res.status(200).json({ ok: true, muted: action });

  /*
   * Quiet actions are recorded but do not post. The channel is for things that
   * need attention sooner rather than later, and these are not: WordPress
   * auto-updating itself fired 13 core_updated posts in a single day, every one
   * of them the system working correctly. A post somebody scrolls past is worse
   * than no post, because it trains people to scroll past the ones that matter.
   *
   * They are still worth knowing in aggregate, so they are counted into the week
   * and reported by the existing weekly digest. Configurable via QUIET_ACTIONS.
   */
  const QUIET = new Set(
    (process.env.QUIET_ACTIONS || 'post_deleted,core_updated,plugin_activated')
      .split(',').map(s => s.trim()).filter(Boolean)
  );
  if (QUIET.has(action)) {
    await recordWeekly('quiet', action, site_name || hostOf(site_url)).catch(() => { /* never fail the site's request */ });
    return res.status(200).json({ ok: true, logged: action, posted: false });
  }

  /*
   * Sites we no longer host do not go to the channel at all, whatever the
   * severity. We cannot act on them, and the plugin stays installed after a
   * handover because the build depends on it, so without this they alert forever.
   * They are still tallied, and the weekly digest reports them under a heading
   * that says plainly that they are not ours.
   */
  const hosting = hostingCheck(await kvGet('on_server_hosts').catch(() => null));
  if (hosting.isExternal(hostOf(site_url))) {
    await recordWeekly('external', action, site_name || hostOf(site_url)).catch(() => { /* never fail the site's request */ });
    return res.status(200).json({ ok: true, logged: action, posted: false, reason: 'not hosted by us' });
  }

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
    await postAlert({ title, description, tags: [hostOf(site_url)] });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(502).json({ error: 'Forward failed', detail: String(e).slice(0, 300) });
  }
}
