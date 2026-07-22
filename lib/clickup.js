// Shared ClickUp helper. The token lives only in env vars (server-side).
export async function createClickUpTask({ title, description, tags = [] }) {
  const { CLICKUP_TOKEN, CLICKUP_LIST_ID } = process.env;
  if (!CLICKUP_TOKEN || !CLICKUP_LIST_ID) throw new Error('ClickUp not configured');
  const r = await fetch(`https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/task`, {
    method: 'POST',
    headers: { Authorization: CLICKUP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: title, markdown_description: description, tags }),
  });
  if (!r.ok) throw new Error(`ClickUp ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}
export function hostOf(u) { try { return new URL(u).host.replace(/:\d+$/, ''); } catch { return 'site'; } }
export function pretty(a) { return String(a).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }
