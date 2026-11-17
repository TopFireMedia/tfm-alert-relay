/**
 * Weekly tally buckets: things worth knowing in aggregate but not worth a post.
 *
 * /api/alert writes them as events arrive, the monitor's weekly digest reads them
 * back. Keyed by ISO week so a bucket rolls over on its own and nothing ever has
 * to be cleaned up.
 *
 * Counts per action and per site rather than individual events, because the
 * digest wants "14 posts deleted across 3 sites", not fourteen lines.
 */
import { kvGet, kvSet } from './kv.js';

/** `prefix:YYYY-Www` for the ISO week containing `when`. */
export function weekKey(prefix, when = Date.now()) {
  const d = new Date(when);
  const y = d.getUTCFullYear();
  const jan1 = Date.UTC(y, 0, 1);
  const week = Math.ceil(((Date.UTC(y, d.getUTCMonth(), d.getUTCDate()) - jan1) / 86400000 + new Date(jan1).getUTCDay() + 1) / 7);
  return `${prefix}:${y}-W${String(week).padStart(2, '0')}`;
}

/** Add one event to this week's bucket. Never throws — callers are in request paths. */
export async function recordWeekly(prefix, action, site, when = Date.now()) {
  const key = weekKey(prefix, when);
  const bucket = (await kvGet(key)) || { actions: {}, sites: {} };
  bucket.actions[action] = (bucket.actions[action] || 0) + 1;
  bucket.sites[site] = (bucket.sites[site] || 0) + 1;
  bucket.updated = Date.now();
  await kvSet(key, bucket);
}

/**
 * Merge the last `weeksBack` buckets into one `{ actions, sites }` tally.
 *
 * Reads two weeks by default because the digest fires on a rolling 7-day timer
 * rather than on a week boundary, so the period it covers usually straddles two
 * ISO weeks.
 */
export async function readWeekly(prefix, weeksBack = 2, now = Date.now()) {
  const keys = [];
  for (let back = 0; back < weeksBack; back++) {
    keys.push(weekKey(prefix, now - back * 7 * 24 * 60 * 60 * 1000));
  }
  const buckets = (await Promise.all(keys.map(k => kvGet(k).catch(() => null)))).filter(Boolean);
  const actions = {}, sites = {};
  for (const b of buckets) {
    for (const [a, n] of Object.entries(b.actions || {})) actions[a] = (actions[a] || 0) + n;
    for (const [s, n] of Object.entries(b.sites || {})) sites[s] = (sites[s] || 0) + n;
  }
  return { actions, sites, found: buckets.length };
}
