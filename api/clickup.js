// Token-gated ClickUp helper (uses the server-side CLICKUP_TOKEN).
//   GET  ?key=TOKEN&whoami=1                 -> the token's owner (who comments post as)
//   GET  ?key=TOKEN&members=1                -> workspace members (id/username) to find a user
//   GET  ?key=TOKEN&task=ID                  -> task name/status/description + comments
//   GET  ?key=TOKEN&task=ID&post=1&text=...  -> post a comment (optional &assignee=<id>)
//   GET  ?key=TOKEN&doc=DOCID                 -> read a Doc's pages (name + markdown content)
//   GET  ?key=TOKEN&checklist=CLID&check_item=ITEMID[&resolved=0] -> resolve/unresolve a checklist item
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

    // Check/uncheck a checklist item: ?checklist=CLID&check_item=ITEMID[&resolved=0]
    if (req.query.check_item) {
      const clId = String(req.query.checklist || '').trim();
      const itemId = String(req.query.check_item).trim();
      if (!clId) return res.status(400).json({ error: 'missing checklist id' });
      const resolved = req.query.resolved !== '0';
      const r = await fetch(`${base}/checklist/${encodeURIComponent(clId)}/checklist_item/${encodeURIComponent(itemId)}`, {
        method: 'PUT', headers, body: JSON.stringify({ resolved }),
      });
      const j = await r.json().catch(() => ({}));
      return res.status(r.status).json({ ok: r.ok, resolved, item: itemId, response: j });
    }

    if (req.query.doc) {
      const docId = String(req.query.doc).trim();
      const v3 = 'https://api.clickup.com/api/v3';
      // Single page: ?doc=DOC&page=PAGE
      if (req.query.page) {
        const pageId = String(req.query.page).trim();
        const pr = await fetch(`${v3}/workspaces/${team}/docs/${encodeURIComponent(docId)}/pages/${encodeURIComponent(pageId)}?content_format=text%2Fmd`, { headers });
        if (!pr.ok) return res.status(pr.status).json({ error: 'page fetch failed', detail: (await pr.text()).slice(0, 300) });
        const p = await pr.json();
        return res.status(200).json({ id: p.id, parent_page_id: p.parent_page_id, name: p.name, content: p.content || '' });
      }
      const url = `${v3}/workspaces/${team}/docs/${encodeURIComponent(docId)}/pages?content_format=text%2Fmd&max_page_depth=-1`;
      const r = await fetch(url, { headers });
      if (!r.ok) return res.status(r.status).json({ error: 'doc fetch failed', detail: (await r.text()).slice(0, 300) });
      const j = await r.json();
      const roots = Array.isArray(j) ? j : (j.pages || []);
      const flat = [];
      const namesOnly = req.query.toc ? true : false;
      const walk = (arr) => arr.forEach((p) => {
        flat.push(namesOnly
          ? { id: p.id, parent_page_id: p.parent_page_id, name: p.name }
          : { id: p.id, parent_page_id: p.parent_page_id, name: p.name, content: p.content || '' });
        if (Array.isArray(p.pages) && p.pages.length) walk(p.pages);
      });
      walk(roots);
      return res.status(200).json({ doc: docId, count: flat.length, pages: flat });
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
      checklists: (task.checklists || []).map((cl) => ({
        id: cl.id, name: cl.name,
        resolved: cl.resolved, unresolved: cl.unresolved,
        items: (cl.items || [])
          .sort((a, b) => (a.orderindex || 0) - (b.orderindex || 0))
          .map((it) => ({ id: it.id, name: it.name, resolved: !!it.resolved })),
      })),
      comments: (cj.comments || []).map((x) => ({ id: x.user && x.user.id, user: x.user && x.user.username, date: x.date, text: x.comment_text })),
    });
  } catch (e) {
    return res.status(502).json({ error: String(e).slice(0, 300) });
  }
}
