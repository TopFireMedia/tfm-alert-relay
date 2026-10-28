// Minimal Upstash Redis REST client. Uses the env vars Vercel's Upstash/KV
// integration injects (supports both KV_* and UPSTASH_* names).
const URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
export function kvConfigured() { return Boolean(URL && TOKEN); }
async function cmd(args) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`KV ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).result;
}
export async function kvGet(key) {
  const v = await cmd(['GET', key]);
  if (v == null) return null;
  try { return JSON.parse(v); } catch { return v; }
}
export async function kvSet(key, val) {
  return cmd(['SET', key, typeof val === 'string' ? val : JSON.stringify(val)]);
}
/**
 * Atomic claim: sets `key` only if it does not already exist, with a TTL.
 * Returns true if THIS caller won the claim, false if someone already held it.
 *
 * Exists because the monitor runs concurrently with itself. The GitHub workflow
 * polls /api/monitor every 5 minutes, and a single pass over the fleet can take
 * longer than that, so two invocations overlap and both read the same site
 * record before either writes. Both then see "not down, and stale" and both
 * create a ClickUp task. The Site Alerts list shows the result plainly: four
 * identical "Site Down - BRAND" tasks created in the same minute, then four
 * matching "Recovered" tasks in the minute after.
 *
 * SET NX is the only part of this that has to be atomic, so it is the only part
 * that got a lock. Everything else stays last-write-wins, which is harmless for
 * a freshness timestamp and much simpler than coordinating the whole pass.
 */
export async function kvClaim(key, ttlSeconds) {
  const res = await cmd(['SET', key, String(Date.now()), 'NX', 'EX', String(ttlSeconds)]);
  return res === 'OK';
}
export async function kvMGet(keys) {
  if (!keys || !keys.length) return [];
  const vals = await cmd(['MGET', ...keys]);
  return (vals || []).map(v => {
    if (v == null) return null;
    try { return JSON.parse(v); } catch { return v; }
  });
}
export async function kvSAdd(set, member) { return cmd(['SADD', set, member]); }
export async function kvSMembers(set) { return (await cmd(['SMEMBERS', set])) || []; }
export async function kvDel(key) { return cmd(['DEL', key]); }
export async function kvSRem(set, member) { return cmd(['SREM', set, member]); }
