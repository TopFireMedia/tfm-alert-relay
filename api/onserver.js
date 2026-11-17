// The authoritative "which hosts live on our servers" list, used to badge sites
// as ours vs external on the dashboard and - since alerts for handed-off sites
// stopped going to the channel - to decide what gets posted at all.
//
// We run more than one Plesk box, so the list is kept per source and unioned.
// It used to be a single key that each push REPLACED, which worked only because
// one server was feeding it: the moment VPS2 started pushing, whichever ran last
// would win and every site on the other box would look external. Under the
// alerting rule that would silence real sites, so sources are explicit now.
//
//   GET ?key=TOKEN                          -> union + per-source counts
//   GET ?key=TOKEN&set=a.com,b.com          -> replace this source's list
//   GET ?key=TOKEN&set=...&source=vps2      -> ... for a named source
//
// `source` defaults to vps1 so the existing VPS1 cron keeps working untouched.
// Fed by each server's cron from the Plesk domain list / WP Toolkit.
import { kvGet, kvSet, kvSAdd, kvSMembers, kvMGet } from '../lib/kv.js';

function normHost(h) {
  return String(h || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/^www\./, '');
}

const SOURCE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export default async function handler(req, res) {
  const token = process.env.DASHBOARD_TOKEN || '';
  if (!token || req.query.key !== token) return res.status(401).json({ error: 'unauthorized' });

  const source = String(req.query.source || 'vps1').trim().toLowerCase();
  if (!SOURCE_RE.test(source)) return res.status(400).json({ error: 'bad source' });

  if (req.query.set !== undefined) {
    const hosts = Array.from(new Set(String(req.query.set || '').split(',').map(normHost).filter(Boolean)));

    /*
     * An empty push is treated as a failure, not as "this server has no sites".
     * The feeding script builds its list from `plesk bin domain --list`, and when
     * that errors it produces an empty string just as happily as a real answer.
     * Accepting it would blank the list, and a blank list turns the alerting rule
     * off fleet-wide without anybody being told.
     */
    if (!hosts.length) {
      return res.status(400).json({ error: 'refusing an empty host list', source });
    }

    await kvSet(`on_server_hosts:${source}`, hosts);
    await kvSAdd('on_server_sources', source);
    const union = await rebuildUnion();
    return res.status(200).json({ ok: true, source, count: hosts.length, union: union.length });
  }

  const sources = await kvSMembers('on_server_sources');
  const perSource = {};
  if (sources.length) {
    const lists = await kvMGet(sources.map(s => `on_server_hosts:${s}`));
    sources.forEach((s, i) => { perSource[s] = (Array.isArray(lists[i]) ? lists[i] : []).length; });
  }
  const cur = await kvGet('on_server_hosts');
  const hosts = Array.isArray(cur) ? cur : [];
  return res.status(200).json({ count: hosts.length, sources: perSource, hosts });
}

/**
 * Recompute the union every source agrees on, and keep it under the original
 * `on_server_hosts` key so existing readers need no changes.
 *
 * Falls back to the legacy single key when no source has reported yet, so an
 * upgrade cannot momentarily empty the list and disable the alerting rule.
 */
async function rebuildUnion() {
  const sources = await kvSMembers('on_server_sources');
  if (!sources.length) {
    const legacy = await kvGet('on_server_hosts');
    return Array.isArray(legacy) ? legacy : [];
  }
  const lists = await kvMGet(sources.map(s => `on_server_hosts:${s}`));
  const union = Array.from(new Set(lists.flatMap(l => (Array.isArray(l) ? l : [])).map(normHost))).sort();
  await kvSet('on_server_hosts', union);
  return union;
}
