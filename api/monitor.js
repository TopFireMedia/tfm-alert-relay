import { kvMGet, kvSet, kvSMembers, kvConfigured } from '../lib/kv.js';
import { createClickUpTask } from '../lib/clickup.js';

// Up/down is decided by DIRECTLY PINGING each site, not by whether it phoned
// home — a heartbeat can lag on a low-traffic site, but a ping is authoritative.
const CONFIRM_FAILS = 3;                 // consecutive failed pings before declaring "down" (rides out transient blips / slow hosts)
const FRESH_WRITE_MS = 8 * 60 * 1000;    // for a still-up site, only re-write last_seen if it's older than this (saves KV writes)

export default async function handler(req, res) {
  if (!kvConfigured()) return res.status(500).json({ error: 'KV not configured' });
  const hosts = await kvSMembers('sites');
  if (!hosts.length) return res.status(200).json({ ok: true, checked: 0, alerted: [], recovered: [] });

  const now = Date.now();
  const recs = (await kvMGet(hosts.map(h => `site:${h}`))).filter(Boolean);
  const reachables = await Promise.all(recs.map(r => ping(r.site_url)));

  const alerted = [], recovered = [];
  await Promise.all(recs.map(async (rec, i) => {
    if (reachables[i]) {
      const wasDown = rec.status === 'down';
      const stale = (now - (rec.last_seen || 0)) >= FRESH_WRITE_MS;
      if (wasDown || stale || rec.ping_fails) {
        rec.status = 'up'; rec.last_seen = now; rec.last_ping = now;
        rec.down_since = null; rec.ping_fails = 0;
        await kvSet(`site:${rec.host}`, rec);
      }
      if (wasDown) {
        recovered.push(rec.host);
        try {
          await createClickUpTask({
            title: `🟢 Recovered — ${rec.site_name}`,
            description: `**Site:** ${rec.site_name} (${rec.site_url})\nBack up — a direct check succeeded.\n**Plugin:** ${rec.plugin_version}`,
            tags: [rec.host, 'recovered'],
          });
        } catch (e) { /* non-fatal */ }
      }
    } else {
      rec.ping_fails = (rec.ping_fails || 0) + 1;
      rec.last_ping = now;
      const goingDown = rec.status !== 'down' && rec.ping_fails >= CONFIRM_FAILS;
      if (goingDown) { rec.status = 'down'; rec.down_since = now; }
      await kvSet(`site:${rec.host}`, rec);
      if (goingDown) {
        alerted.push(rec.host);
        try {
          await createClickUpTask({
            title: `🔴 Site Down — ${rec.site_name}`,
            description: `**Site:** ${rec.site_name} (${rec.site_url})\nA direct check failed ${rec.ping_fails}× in a row.\n**Last plugin version:** ${rec.plugin_version}`,
            tags: [rec.host, 'down'],
          });
        } catch (e) { /* non-fatal */ }
      }
    }
  }));

  return res.status(200).json({ ok: true, checked: recs.length, alerted, recovered });
}

async function ping(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 10000);
    const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: c.signal, headers: { 'User-Agent': 'TFM-Monitor' } });
    clearTimeout(t);
    return r.status > 0 && r.status < 500; // any non-server-error response = server is up
  } catch { return false; }
}
