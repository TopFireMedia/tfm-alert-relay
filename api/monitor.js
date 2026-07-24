import { kvMGet, kvSet, kvSMembers, kvConfigured } from '../lib/kv.js';
import { createClickUpTask } from '../lib/clickup.js';

// A site is "up" if we can reach it by a direct ping OR it recently sent a
// heartbeat. It's only "down" if BOTH fail: consecutive pings fail AND it hasn't
// checked in for a while. This avoids false downs when our datacenter ping is
// firewall-blocked/timed-out but the site is actually fine (proven by its
// outbound heartbeat).
const CONFIRM_FAILS = 3;                    // consecutive failed pings before "down" is even possible
const FRESH_WRITE_MS = 8 * 60 * 1000;       // only re-write a healthy site's last_seen when it's older than this (saves KV writes)
const HEARTBEAT_GRACE_MS = 30 * 60 * 1000;  // a heartbeat within this window vetoes a "down"
const PING_TIMEOUT_MS = 6000;               // well under the 10s function ceiling so pings aren't mass-aborted

export default async function handler(req, res) {
  if (!kvConfigured()) return res.status(500).json({ error: 'KV not configured' });
  const hosts = await kvSMembers('sites');
  if (!hosts.length) return res.status(200).json({ ok: true, checked: 0, alerted: [], recovered: [] });

  const now = Date.now();
  const recs = (await kvMGet(hosts.map(h => `site:${h}`))).filter(Boolean);
  const reachables = await Promise.all(recs.map(r => ping(r.site_url)));

  const alerted = [], recovered = [];
  await Promise.all(recs.map(async (rec, i) => {
    const reachable = reachables[i];
    const heardRecently = rec.last_heartbeat && (now - rec.last_heartbeat) < HEARTBEAT_GRACE_MS;
    const alive = reachable || heardRecently;

    if (alive) {
      const wasDown = rec.status === 'down';
      const needRefresh = reachable && (now - (rec.last_seen || 0)) >= FRESH_WRITE_MS;
      if (wasDown || rec.ping_fails || needRefresh) {
        rec.status = 'up';
        rec.down_since = null;
        rec.ping_fails = 0;
        if (reachable) { rec.last_seen = now; rec.last_ping = now; }
        await kvSet(`site:${rec.host}`, rec);
      }
      if (wasDown) {
        recovered.push(rec.host);
        try {
          await createClickUpTask({
            title: `🟢 Recovered — ${rec.site_name}`,
            description: `**Site:** ${rec.site_name} (${rec.site_url})\nBack up (${reachable ? 'direct check succeeded' : 'heartbeat received'}).\n**Plugin:** ${rec.plugin_version}`,
            tags: [rec.host, 'recovered'],
          });
        } catch (e) { /* non-fatal */ }
      }
    } else {
      // Unreachable AND no recent heartbeat.
      rec.ping_fails = (rec.ping_fails || 0) + 1;
      rec.last_ping = now;
      const goingDown = rec.status !== 'down' && rec.ping_fails >= CONFIRM_FAILS;
      if (goingDown) { rec.status = 'down'; rec.down_since = now; }
      await kvSet(`site:${rec.host}`, rec);
      if (goingDown) {
        alerted.push(rec.host);
        const quietMin = rec.last_heartbeat ? Math.round((now - rec.last_heartbeat) / 60000) : null;
        try {
          await createClickUpTask({
            title: `🔴 Site Down — ${rec.site_name}`,
            description: `**Site:** ${rec.site_name} (${rec.site_url})\nDirect check failed ${rec.ping_fails}× in a row AND no heartbeat${quietMin ? ` for ~${quietMin} min` : ' on record'}.\n**Last plugin version:** ${rec.plugin_version}`,
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
    const t = setTimeout(() => c.abort(), PING_TIMEOUT_MS);
    const r = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: c.signal,
      // A browser-like UA so security plugins/WAFs are less likely to block us.
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TFM-Monitor/1.0; +https://topfiremedia.com)' },
    });
    clearTimeout(t);
    return r.status > 0 && r.status < 500; // any non-server-error response = server is up
  } catch { return false; }
}
