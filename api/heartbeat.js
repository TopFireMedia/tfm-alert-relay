import { kvGet, kvSet, kvSAdd, kvConfigured, kvClaim } from '../lib/kv.js';
import { postAlert, hostOf } from '../lib/clickup.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!kvConfigured()) return res.status(500).json({ error: 'KV not configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const { site_url, site_name, plugin_version, php_version, wp_version, custom_scripts, scf_active, search_indexing, auto_update, update_token_set, cookie_consent } = body;
  if (!site_url) return res.status(400).json({ error: 'missing site_url' });

  const host = hostOf(site_url);
  const now = Date.now();
  const prev = await kvGet(`site:${host}`);
  const cs = custom_scripts && typeof custom_scripts === 'object' ? custom_scripts : {};
  const rec = {
    host, site_url, site_name: site_name || host,
    plugin_version: plugin_version || '', php_version: php_version || '', wp_version: wp_version || '',
    custom_scripts: {
      head: Boolean(cs.head),
      footer: Boolean(cs.footer),
      total_bytes: Number(cs.total_bytes) || 0,
    },
    scf_active: Boolean(scf_active),
    // undefined until a site reports it (3.23.0+); keep as tri-state on the dashboard.
    search_indexing: (search_indexing === true || search_indexing === false) ? search_indexing : (prev ? prev.search_indexing : undefined),
    // Update health (3.31.0+) — tri-state so old sites show "—" not a false flag.
    auto_update: (auto_update === true || auto_update === false) ? auto_update : (prev ? prev.auto_update : undefined),
    update_token_set: (update_token_set === true || update_token_set === false) ? update_token_set : (prev ? prev.update_token_set : undefined),
    // Consent system in use (tracking / cookie[legacy] / none). Gate for removing
    // the legacy cookie-consent module: it's safe once no site reports 'cookie'.
    cookie_consent: (cookie_consent && typeof cookie_consent === 'object') ? cookie_consent : (prev ? prev.cookie_consent : undefined),
    // A heartbeat is positive proof the site is up (and outbound, so it isn't
    // firewall-blocked the way an inbound ping can be). last_heartbeat lets the
    // monitor veto a false "down" from a blocked/timed-out ping.
    last_seen: now, last_heartbeat: now,
    last_ping: prev && prev.last_ping ? prev.last_ping : now,
    status: 'up', down_since: null, ping_fails: 0,
  };
  await kvSet(`site:${host}`, rec);
  // Only add to the set the first time we hear from a site. SADD on every
  // heartbeat was a third of all heartbeat commands and a no-op after the first
  // one. `prev` being null is the reliable signal for "we've not seen this
  // host before" — the record and the set membership are written together.
  if (!prev) {
    await kvSAdd('sites', host);
  }

  /*
   * Recovery: it was flagged down and just checked in again.
   *
   * This is the SECOND place a "Recovered" notice can be emitted; monitor.js
   * recover() is the other. That one has always suppressed recoveries shorter
   * than RECOVER_NOTIFY_MS, because a site that was never really down does not
   * need announcing. This path had no such guard and posted unconditionally,
   * which is why the channel kept showing "Back up after ~0 min down" — a
   * message monitor.js could not have produced. Seen on coconutkennysfranchise
   * (Nov 1) and durafleet.wpenginepowered.com (Nov 6); both were false downs
   * being cleared, and announcing the clear is just a second piece of noise
   * about an event that never happened.
   *
   * The threshold must match monitor.js. It is duplicated rather than imported
   * because api/ modules are separate serverless entry points and monitor.js
   * pulls in TLS and digest code this endpoint has no business loading on every
   * heartbeat.
   */
  const RECOVER_NOTIFY_MS = 15 * 60 * 1000; // keep in step with monitor.js
  if (prev && prev.status === 'down') {
    const downMs = prev.down_since ? now - prev.down_since : 0;
    // Same claim key monitor.js uses, so the two paths cannot both announce the
    // same recovery when a heartbeat and a monitor pass land together.
    const worthSaying = downMs >= RECOVER_NOTIFY_MS;
    const won = worthSaying && await kvClaim(`claim:recovered:${host}`, 30 * 60).catch(() => true);
    if (won) {
      try {
        await postAlert({
          title: `🟢 Recovered — ${rec.site_name}`,
          description: `**Site:** ${rec.site_name} (${site_url})\n**Back up** after ~${Math.round(downMs / 60000)} min down.\n**Plugin:** ${rec.plugin_version}`,
          tags: [host, 'recovered'],
        });
      } catch (e) { /* non-fatal */ }
    }
  }
  return res.status(200).json({ ok: true });
}
