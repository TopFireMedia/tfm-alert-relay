import { kvGet, kvSet, kvSAdd, kvConfigured } from '../lib/kv.js';
import { createClickUpTask, hostOf } from '../lib/clickup.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!kvConfigured()) return res.status(500).json({ error: 'KV not configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const { site_url, site_name, plugin_version, php_version, wp_version } = body;
  if (!site_url) return res.status(400).json({ error: 'missing site_url' });

  const host = hostOf(site_url);
  const now = Date.now();
  const prev = await kvGet(`site:${host}`);
  const rec = {
    host, site_url, site_name: site_name || host,
    plugin_version: plugin_version || '', php_version: php_version || '', wp_version: wp_version || '',
    last_seen: now, status: 'up', down_since: null,
  };
  await kvSet(`site:${host}`, rec);
  await kvSAdd('sites', host);

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
