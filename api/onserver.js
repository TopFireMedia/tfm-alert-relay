// The authoritative "which hosts live on our Plesk server" list, used by the
// fleet dashboard to badge sites as ours vs external. Keyed to hostnames (not
// raw IP) so Cloudflare-proxied sites on our box are still recognised.
//   GET ?key=TOKEN                 -> current list
//   GET ?key=TOKEN&set=a.com,b.com -> replace the list (normalised, deduped)
// Fed by the Plesk server cron from the WP Toolkit / domain list.
import { kvGet, kvSet } from '../lib/kv.js';

function normHost(h) {
  return String(h || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/^www\./, '');
}

export default async function handler(req, res) {
  const token = process.env.DASHBOARD_TOKEN || '';
  if (!token || req.query.key !== token) return res.status(401).json({ error: 'unauthorized' });

  if (req.query.set !== undefined) {
    const hosts = Array.from(new Set(String(req.query.set || '').split(',').map(normHost).filter(Boolean)));
    await kvSet('on_server_hosts', hosts);
    return res.status(200).json({ ok: true, count: hosts.length });
  }

  const cur = await kvGet('on_server_hosts');
  const hosts = Array.isArray(cur) ? cur : [];
  return res.status(200).json({ count: hosts.length, hosts });
}
