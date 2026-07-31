// Token-gated ClickUp task reader (uses the server-side CLICKUP_TOKEN).
//   GET /api/clickup?key=DASHBOARD_TOKEN&task=86bb67hag
// Returns the task's name/status/description and its comments.
export default async function handler(req, res) {
  const token = process.env.DASHBOARD_TOKEN || '';
  if (!token || req.query.key !== token) return res.status(401).json({ error: 'unauthorized' });

  const ct = process.env.CLICKUP_TOKEN;
  if (!ct) return res.status(500).json({ error: 'CLICKUP_TOKEN not set' });
  const id = String(req.query.task || '').trim();
  if (!id) return res.status(400).json({ error: 'missing task id' });
  const team = String(req.query.team || process.env.CLICKUP_TEAM_ID || '90141190894');

  const base = 'https://api.clickup.com/api/v2';
  const headers = { Authorization: ct };
  const tryFetch = async (custom) => {
    const q = custom ? `?custom_task_ids=true&team_id=${team}` : '';
    const t = await fetch(`${base}/task/${encodeURIComponent(id)}${q}`, { headers });
    return t;
  };

  try {
    let t = await tryFetch(false);
    let custom = false;
    if (t.status === 401 || t.status === 404) { t = await tryFetch(true); custom = true; }
    if (!t.ok) return res.status(t.status).json({ error: 'clickup task fetch failed', detail: (await t.text()).slice(0, 300) });
    const task = await t.json();

    const cq = custom ? `?custom_task_ids=true&team_id=${team}` : '';
    const cr = await fetch(`${base}/task/${encodeURIComponent(id)}/comment${cq}`, { headers });
    const cj = cr.ok ? await cr.json() : { comments: [] };

    return res.status(200).json({
      id: task.id,
      name: task.name,
      status: task.status && task.status.status,
      url: task.url,
      description: task.description || task.text_content || '',
      comments: (cj.comments || []).map((x) => ({
        user: x.user && x.user.username,
        date: x.date,
        text: x.comment_text || (Array.isArray(x.comment) ? x.comment.map((b) => b.text).join('') : ''),
      })),
    });
  } catch (e) {
    return res.status(502).json({ error: String(e).slice(0, 300) });
  }
}
