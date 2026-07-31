import tls from 'node:tls';
import { kvMGet, kvSet, kvSMembers, kvConfigured } from '../lib/kv.js';
import { createClickUpTask, hostOf } from '../lib/clickup.js';

// "Down" means we have NOT heard from a site by ANY means — neither its outbound
// heartbeat nor a successful inbound ping — for DOWN_AFTER_MS. A failed ping on
// its own never marks a site down: pinging dozens of sites from a 10s serverless
// function (and from a datacenter IP that WAFs may block) is inherently flaky, so
// the ping is only ever a POSITIVE signal that refreshes freshness. This makes
// false downs essentially impossible while still catching genuinely dead sites.
const DOWN_AFTER_MS = 45 * 60 * 1000;      // no contact (heartbeat or good ping) for this long => down
const FRESH_WRITE_MS = 30 * 60 * 1000;     // on a good ping, only re-write last_seen if older than this
const RECOVER_NOTIFY_MS = 15 * 60 * 1000;  // only alert "recovered" if it was actually down this long
const PING_TIMEOUT_MS = 4000;              // short + best-effort; aborted pings are harmless
const SSL_INTERVAL_MS = 12 * 60 * 60 * 1000; // re-check a site's TLS cert at most every 12h
const SSL_MAX_PER_RUN = 20;                  // cap cert checks per run so the function stays fast

export default async function handler(req, res) {
  if (!kvConfigured()) return res.status(500).json({ error: 'KV not configured' });
  const hosts = await kvSMembers('sites');
  if (!hosts.length) return res.status(200).json({ ok: true, checked: 0, alerted: [], recovered: [] });

  const now = Date.now();
  const recs = (await kvMGet(hosts.map(h => `site:${h}`))).filter(Boolean);
  const reachables = await Promise.all(recs.map(r => ping(r.site_url)));

  // SSL: check a bounded number of sites whose cert hasn't been checked in 12h.
  const sslDue = recs.filter(r => !r.ssl_checked || (now - r.ssl_checked) >= SSL_INTERVAL_MS).slice(0, SSL_MAX_PER_RUN);
  const sslResults = new Map();
  await Promise.all(sslDue.map(async (r) => { sslResults.set(r.host, await certDaysLeft(hostOf(r.site_url))); }));

  const alerted = [], recovered = [];
  await Promise.all(recs.map(async (rec, i) => {
    const reachable = reachables[i];
    const lastSeen = rec.last_seen || 0;
    const wasDown = rec.status === 'down';
    const downMs = wasDown && rec.down_since ? now - rec.down_since : 0;

    const sslUpdated = sslResults.has(rec.host);
    if (sslUpdated) { rec.ssl_days_left = sslResults.get(rec.host); rec.ssl_checked = now; }

    if (reachable) {
      if (wasDown || sslUpdated || (now - lastSeen) >= FRESH_WRITE_MS) {
        rec.status = 'up'; rec.down_since = null; rec.ping_fails = 0;
        rec.last_seen = now; rec.last_ping = now;
        await kvSet(`site:${rec.host}`, rec);
      }
      if (wasDown) recover(rec, recovered, 'a direct check succeeded', downMs);
      return;
    }

    // Ping failed — decide purely on how long since we last heard from it.
    const stale = (now - lastSeen) >= DOWN_AFTER_MS;
    if (wasDown && !stale) {
      rec.status = 'up'; rec.down_since = null; rec.ping_fails = 0;
      await kvSet(`site:${rec.host}`, rec);
      recover(rec, recovered, 'a heartbeat was received', downMs);
    } else if (!wasDown && stale) {
      rec.status = 'down'; rec.down_since = now;
      await kvSet(`site:${rec.host}`, rec);
      alerted.push(rec.host);
      const quietMin = Math.round((now - lastSeen) / 60000);
      try {
        await createClickUpTask({
          title: `🔴 Site Down — ${rec.site_name}`,
          description: `**Site:** ${rec.site_name} (${rec.site_url})\nNo heartbeat and no successful direct check for ~${quietMin} min.\n**Last plugin version:** ${rec.plugin_version}`,
          tags: [rec.host, 'down'],
        });
      } catch (e) { /* non-fatal */ }
    } else if (sslUpdated) {
      await kvSet(`site:${rec.host}`, rec); // no status change, but persist the fresh cert reading
    }
  }));

  return res.status(200).json({ ok: true, checked: recs.length, alerted, recovered, ssl_checked: sslDue.length });
}

function recover(rec, recovered, why, downMs) {
  recovered.push(rec.host);
  if (downMs < RECOVER_NOTIFY_MS) return; // brief blip / false down being cleared — recover silently
  createClickUpTask({
    title: `🟢 Recovered — ${rec.site_name}`,
    description: `**Site:** ${rec.site_name} (${rec.site_url})\nBack up after ~${Math.round(downMs / 60000)} min — ${why}.\n**Plugin:** ${rec.plugin_version}`,
    tags: [rec.host, 'recovered'],
  }).catch(() => { /* non-fatal */ });
}

async function ping(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), PING_TIMEOUT_MS);
    const r = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: c.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TFM-Monitor/1.0; +https://topfiremedia.com)' },
    });
    clearTimeout(t);
    return r.status > 0 && r.status < 500;
  } catch { return false; }
}

// Days until the site's TLS certificate expires (negative = already expired,
// null = couldn't read it). Best-effort; never throws.
function certDaysLeft(host) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false }, () => {
        const cert = socket.getPeerCertificate();
        try { socket.end(); } catch { /* ignore */ }
        if (cert && cert.valid_to) {
          finish(Math.round((new Date(cert.valid_to).getTime() - Date.now()) / 86400000));
        } else finish(null);
      });
      socket.setTimeout(5000, () => { try { socket.destroy(); } catch { /* */ } finish(null); });
      socket.on('error', () => finish(null));
    } catch { finish(null); }
  });
}
