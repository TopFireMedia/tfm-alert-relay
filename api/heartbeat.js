import { kvGet, kvSet, kvSAdd, kvConfigured } from '../lib/kv.js';
import { createClickUpTask, hostOf } from '../lib/clickup.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!kvConfigured()) return res.status(500).json({ error: 'KV not configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const { site_url, site_name, plugin_version, php_version, wp_version, custom_scripts, scf_active, search_indexing, auto_update, update_token_set } = body;
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

  // Recovery: it was flagged down and just checked in again.
  if (prev && prev.status === 'down') {
    const downMin = prev.down_since ? Math.round((now - prev.down_since) / 60000) : 0;
    try {
      await createClickUpTask({
        title: `🟢 Recovered — ${rec.site_name}`,
        description: `**Site:** ${rec.site_name} (${site_url})\n**Back up** after ~${downMin} min down.\n**Plugin:** ${rec.plugin_version}`,
        tags: [host, 'recovered'],
      });
    } catch (e) { /* non-fatal */ }
  }
  return res.status(200).json({ ok: true });
}
