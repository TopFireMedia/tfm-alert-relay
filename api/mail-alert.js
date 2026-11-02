import { postAlert } from '../lib/clickup.js';
import { kvClaim } from '../lib/kv.js';

/**
 * Domain and hosting access grants, posted to Site-Alerts.
 *
 * ## Why this exists
 *
 * When a client gives TFM delegate access to a registrar or host, the only
 * record is an email in analytics@topfiremedia.com. Nobody is watching that
 * mailbox, so a grant arrives, nobody acts on it, and the access quietly
 * expires or is never used. Revocations are worse: access to a client's domain
 * disappears and the first anyone hears of it is when a DNS change is needed.
 *
 * Measured over 400 days in ssimpson@ (analytics@ sees more): 36 GoDaddy access
 * events, of which 17 were removals. Roughly three a month, which is the right
 * volume for a channel.
 *
 * ## Why a mail watcher rather than ClickUp
 *
 * ClickUp's Gmail integration attaches mail to tasks from the side panel; it is
 * user-initiated and has no "mail arrived" trigger that can post to a channel.
 * Its email-to-task address creates tasks, which is the pattern the alerting
 * rebuild deliberately removed. ClickUp agents act on ClickUp data and cannot
 * watch an external inbox.
 *
 * So the sender is an Apps Script running inside analytics@ on a time trigger.
 * That keeps Gmail credentials inside Google: no app password, no OAuth refresh
 * token in Vercel env, nothing this service could leak.
 *
 * ## What is deliberately not sent
 *
 * No message bodies. These emails carry customer numbers, account identifiers
 * and sometimes one-time links. The channel gets sender, subject, date and a
 * Gmail deep link, which is enough to decide whether to act and to find the
 * original. Anyone who needs the detail opens the mail.
 */

/** Shared secret with the Apps Script. Set MAIL_ALERT_TOKEN in Vercel env. */
function authorized(req) {
  const expected = process.env.MAIL_ALERT_TOKEN || '';
  if (!expected) return false;
  const got = req.headers['x-mail-token'] || '';
  return got === expected;
}

/**
 * Grant or revocation, decided from the subject.
 *
 * Both are posted, but they read very differently in a channel and the
 * revocations are the ones worth noticing, so they are labelled apart.
 *
 * Order matters: GoDaddy's removal subject is "Account Access Invite Removed",
 * which contains the grant wording too. Revocation is tested first so the
 * longer, more specific phrasing wins.
 */
const REVOKED = /\b(removed|revoked|cancell?ed|expired|no longer has|terminated)\b/i;
/*
 * Two alternations, not one. The whole-word terms are anchored at both ends, but
 * "invit", "delegat" and "collaborat" are stems that have to match "Invite",
 * "Invitation", "delegated", "Collaboration" and so on, so they are anchored only
 * at the start. Putting them in the first group left a trailing \b after the stem,
 * which silently failed on GoDaddy's "Account Access Invite" and SiteGround's
 * "Collaboration Invitation" - the two commonest grant subjects we get.
 */
const GRANTED = /\b(granted|given you|added you|shared with you|access to their account)\b|\b(invit|delegat|collaborat)/i;

export function classify(subject) {
  const s = String(subject || '');
  if (REVOKED.test(s)) return 'revoked';
  if (GRANTED.test(s)) return 'granted';
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const { message_id, subject, from, date, link, mailbox } = body;
  if (!message_id || !subject) {
    return res.status(400).json({ error: 'Missing required fields (message_id, subject)' });
  }

  const kind = classify(subject);
  if (!kind) return res.status(200).json({ ok: true, skipped: 'not an access event', subject });

  /*
   * Dedupe on the Gmail message id. The Apps Script searches a rolling window
   * rather than tracking what it has sent, so a message is offered on every run
   * until it falls out of the window. 30 days of TTL comfortably outlives any
   * sane window and costs nothing.
   */
  const won = await kvClaim(`mail:${message_id}`, 60 * 60 * 24 * 30);
  if (!won) return res.status(200).json({ ok: true, duplicate: message_id });

  const vendor = (String(from || '').match(/@([\w.-]+)/) || [, 'unknown'])[1]
    .replace(/^(email|mail|notifications?|updates?)\./, '');

  const title = kind === 'revoked'
    ? `Access removed: ${vendor}`
    : `Access granted: ${vendor}`;

  const lines = [
    `**${subject}**`,
    '',
    `From: ${from || 'unknown'}`,
    date ? `Received: ${date}` : null,
    mailbox ? `Mailbox: ${mailbox}` : null,
    link ? `\n[Open in Gmail](${link})` : null,
    kind === 'revoked'
      ? '\nSomeone has removed our access. If this account is still live for us, it needs re-granting.'
      : '\nConfirm the access works and record it before the invite expires.',
  ].filter(Boolean);

  await postAlert({
    title,
    description: lines.join('\n'),
    tags: ['access', vendor, kind],
  });

  return res.status(200).json({ ok: true, posted: kind, vendor, message_id });
}
