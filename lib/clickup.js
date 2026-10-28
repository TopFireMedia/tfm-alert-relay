// Shared ClickUp helper. Credentials live only in env vars (server-side).

/**
 * Post a fleet alert into the ClickUp Chat channel.
 *
 * This used to create a ClickUp task per alert, and the Site Alerts list is the
 * argument against it: 481 tasks, not one of them ever closed. A task implies an
 * owner and a close, and most of these never needed either - the majority were
 * "site down" followed minutes later by "recovered", a pair nobody has to action.
 * The list stopped being read, which is why a dead ClickUp token went unnoticed
 * for two months.
 *
 * A channel carries the same information with no implied ownership and no
 * cleanup debt, which is what a notification actually is.
 */
export async function postAlert({ title, description, tags = [] }) {
  const { CLICKUP_TOKEN, CLICKUP_WORKSPACE_ID, CLICKUP_ALERT_CHANNEL_ID } = process.env;
  if (!CLICKUP_TOKEN || !CLICKUP_WORKSPACE_ID || !CLICKUP_ALERT_CHANNEL_ID) {
    throw new Error('ClickUp chat not configured');
  }
  const footer = tags.length ? `\n\n_${tags.join(' · ')}_` : '';
  const content = `**${title}**\n\n${description}${footer}`.slice(0, 15000);
  const r = await fetch(
    `https://api.clickup.com/api/v3/workspaces/${CLICKUP_WORKSPACE_ID}/chat/channels/${CLICKUP_ALERT_CHANNEL_ID}/messages`,
    {
      method: 'POST',
      headers: { Authorization: CLICKUP_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'message', content_format: 'text/md', content }),
    },
  );
  if (!r.ok) throw new Error(`ClickUp chat ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

export function hostOf(u) { try { return new URL(u).host.replace(/:\d+$/, ''); } catch { return 'site'; } }
export function pretty(a) { return String(a).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }
