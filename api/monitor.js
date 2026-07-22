import { kvGet, kvSet, kvSMembers, kvConfigured } from '../lib/kv.js';
import { createClickUpTask } from '../lib/clickup.js';

const THRESHOLD_MS = 45 * 60 * 1000; // no heartbeat for 45 min

export default async function handler(req, res) {
  if (!kvConfigured()) return res.status(500).json({ error: 'KV not configured' });
  const hosts = await kvSMembers('sites');
  const now = Date.now();
  const alerted = [];

  for (const host of hosts) {
    const rec = await kvGet(`site:${host}`);
    if (!rec || rec.status === 'down') continue;
    if (now - rec.last_seen <= THRESHOLD_MS) continue;

    // Confirm with a direct request before crying "down" (a heartbeat can miss
    // if wp-cron is starved on a low-traffic but otherwise-healthy site).
    const reachable = await ping(rec.site_url);
    if (reachable) continue;

    rec.status = 'down'; rec.down_since = now;
    await kvSet(`site:${host}`, rec);
    const mins = Math.round((now - rec.last_seen) / 60000);
    try {
      await createClickUpTask({
        title: `🔴 Site Down — ${rec.site_name}`,
        description: `**Site:** ${rec.site_name} (${rec.site_url})\n**No heartbeat for ~${mins} min** and a direct check failed.\n**Last plugin version:** ${rec.plugin_version}`,
        tags: [host, 'down'],
      });
      alerted.push(host);
    } catch (e) { /* non-fatal */ }
  }
  return res.status(200).json({ ok: true, checked: hosts.length, alerted });
}

async function ping(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
    const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: c.signal, headers: { 'User-Agent': 'TFM-Monitor' } });
    clearTimeout(t);
    return r.status > 0 && r.status < 500; // any non-server-error response = server is up
  } catch { return false; }
}
