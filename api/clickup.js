// Token-gated ClickUp helper (uses the server-side CLICKUP_TOKEN).
//   GET  ?key=TOKEN&whoami=1                 -> the token's owner (who comments post as)
//   GET  ?key=TOKEN&members=1                -> workspace members (id/username) to find a user
//   GET  ?key=TOKEN&task=ID                  -> task name/status/description + comments
//   GET  ?key=TOKEN&task=ID&post=1&text=...  -> post a comment (optional &assignee=<id>)
export default async function handler(req, res) {
  const token = process.env.DASHBOARD_TOKEN || '';
  if (!token || req.query.key !== token) return res.status(401).json({ error: 'unauthorized' });
  const ct = process.env.CLICKUP_TOKEN;
  if (!ct) return res.status(500).json({ error: 'CLICKUP_TOKEN not set' });

  const base = 'https://api.clickup.com/api/v2';
  const headers = { Authorization: ct, 'Content-Type': 'application/json' };
  const team = String(req.query.team || process.env.CLICKUP_TEAM_ID || '90141190894');

  try {
    if (req.query.whoami) {
      const r = await fetch(`${base}/user`, { headers });
      const j = await r.json();
      return res.status(r.status).json(j.user ? { id: j.user.id, username: j.user.username, email: j.user.email } : j);
    }

    if (req.query.members) {
      const r = await fetch(`${base}/team`, { headers });
      const j = await r.json();
      const members = [];
      (j.teams || []).forEach((t) => {
        if (String(t.id) === team) (t.members || []).forEach((m) => members.push({ id: m.user.id, username: m.user.username, email: m.user.email }));
      });
      return res.status(200).json({ members });
    }

    const id = String(req.query.task || '').trim();
    if (!id) return res.status(400).json({ error: 'missing task id' });

    if (req.query.post) {
      const text = String(req.query.text || '');
      if (!text) return res.status(400).json({ error: 'missing text' });
      const body = { comment_text: text, notify_all: false };
      if (req.query.assignee) body.assignee = Number(req.query.assignee);
      let r = await fetch(`${base}/task/${encodeURIComponent(id)}/comment`, { method: 'POST', headers, body: JSON.stringify(body) });
      if (r.status === 401 || r.status === 404) {
        r = await fetch(`${base}/task/${encodeURIComponent(id)}/comment?custom_task_ids=true&team_id=${team}`, { method: 'POST', headers, body: JSON.stringify(body) });
      }
      const j = await r.json();
      return res.status(r.status).json(j);
    }

    // Read the task + comments.
    let t = await fetch(`${base}/task/${encodeURIComponent(id)}`, { headers });
    let custom = false;
    if (t.status === 401 || t.status === 404) { t = await fetch(`${base}/task/${encodeURIComponent(id)}?custom_task_ids=true&team_id=${team}`, { headers }); custom = true; }
    if (!t.ok) return res.status(t.status).json({ error: 'fetch failed', detail: (await t.text()).slice(0, 300) });
    const task = await t.json();
    const cq = custom ? `?custom_task_ids=true&team_id=${team}` : '';
    const cr = await fetch(`${base}/task/${encodeURIComponent(id)}/comment${cq}`, { headers });
    const cj = cr.ok ? await cr.json() : { comments: [] };
    return res.status(200).json({
      id: task.id, name: task.name, status: task.status && task.status.status, url: task.url,
      description: task.description || task.text_content || '',
      comments: (cj.comments || []).map((x) => ({ id: x.user && x.user.id, user: x.user && x.user.username, date: x.date, text: x.comment_text })),
    });
  } catch (e) {
    return res.status(502).json({ error: String(e).slice(0, 300) });
  }
}
