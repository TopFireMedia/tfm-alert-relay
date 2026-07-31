import { kvGet, kvSet, kvConfigured } from '../lib/kv.js';

// Fleet auto-update rollout policy.
//   GET  /api/rollout                         -> { hold_at, canary }  (public; not sensitive)
//   GET  /api/rollout?key=TOKEN&hold_at=3.34.0 -> pin the fleet at 3.34.0 (canary sites ignore it)
//   GET  /api/rollout?key=TOKEN&hold_at=clear  -> lift the hold (fleet takes latest)
//   GET  /api/rollout?key=TOKEN&canary=a.com,b.com -> set the canary hosts
// The plugin reads this and won't auto-update PAST hold_at unless it's a canary.
export default async function handler(req, res) {
  if (!kvConfigured()) return res.status(500).json({ error: 'KV not configured' });
  const token = process.env.DASHBOARD_TOKEN || '';
  const authed = token && req.query.key === token;

  // Update the policy (token-protected).
  if (authed && (req.query.hold_at !== undefined || req.query.canary !== undefined)) {
    const cur = (await kvGet('rollout_policy')) || {};
    if (req.query.hold_at !== undefined) {
      const h = String(req.query.hold_at).trim();
      cur.hold_at = (h === '' || h.toLowerCase() === 'clear' || h.toLowerCase() === 'none') ? null : h;
    }
    if (req.query.canary !== undefined) {
      cur.canary = String(req.query.canary).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    }
    await kvSet('rollout_policy', cur);
    return res.status(200).json({ ok: true, policy: { hold_at: cur.hold_at || null, canary: cur.canary || [] } });
  }

  const policy = (await kvGet('rollout_policy')) || {};
  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.status(200).json({ hold_at: policy.hold_at || null, canary: policy.canary || [] });
}
