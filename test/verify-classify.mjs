/**
 * Classifier check against 531 real vendor messages pulled from
 * analytics@topfiremedia.com over 400 days (test/mail-corpus.json, subjects and
 * senders only - no bodies, no recipients).
 *
 * Unit cases alone were not enough. They passed while the classifier was still
 * flagging IONOS webinar invitations, a Cloudflare baseball event and a Wix
 * billing cancellation, because none of those shapes occurred to me until the
 * real corpus was in front of me.
 *
 *   node test/verify-classify.mjs
 */
import { readFileSync } from 'fs';
import { classify } from '../api/mail-alert.js';

const rows = JSON.parse(readFileSync(new URL('./mail-corpus.json', import.meta.url), 'utf8'));

/* Hand-labelled: uses access vocabulary, is not an access event. */
const NOISE = [
  /External Domain Has Been Removed/i, /SSL Certificate Has Expired/i,
  /Webinar Invitation/i, /Cloudflare Connect 2026/i, /onto the field at Oracle Park/i,
  /Contact successfully (removed|added)/i, /Premium Plan has been Canceled/i,
];
/* Hand-labelled: must always be caught. */
const REAL = [
  /given you (account )?access/i, /has given you access to their account/i,
  /Account Access Invite/i, /account access has been removed/i,
  /invited you to (join|help manage)/i, /Permissions invitation/i,
  /Cancelled collaboration/i, /\[Invitation\] Join the .* account/i,
];

let bad = 0;
const noise = rows.filter(r => NOISE.some(x => x.test(r.subject)));
const real  = rows.filter(r => REAL.some(x => x.test(r.subject)));

const leaked = noise.filter(r => classify(r.subject));
const missed = real.filter(r => !classify(r.subject));

console.log(`corpus ${rows.length} | labelled noise ${noise.length} | labelled real ${real.length}`);
console.log(`  ${leaked.length === 0 ? 'PASS' : 'FAIL'}  no noise reaches the channel (${leaked.length} leaked)`);
console.log(`  ${missed.length === 0 ? 'PASS' : 'FAIL'}  every real event is caught (${missed.length} missed)`);
leaked.forEach(r => { bad++; console.log(`     LEAKED: ${r.subject.slice(0, 80)}`); });
missed.forEach(r => { bad++; console.log(`     MISSED: ${r.subject.slice(0, 80)}`); });

const flagged = rows.filter(r => classify(r.subject));
const g = flagged.filter(r => classify(r.subject) === 'granted').length;
console.log(`\nflagged ${flagged.length} of ${rows.length}  (${g} grants, ${flagged.length - g} revocations, ~${(flagged.length / 13.2).toFixed(1)}/month)`);
console.log(bad === 0 ? 'all cases passed' : `${bad} FAILED`);
process.exit(bad ? 1 : 0);
