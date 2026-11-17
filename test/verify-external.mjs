/**
 * The rule: a site we do not host never posts to the channel, whatever the
 * severity, and is tallied for the digest instead.
 *
 * The case that matters most is the last one. If the Plesk host list is ever
 * empty or unreachable, treating everything as external would silence the whole
 * fleet, and silently - the relay has already had one two-month outage nobody
 * noticed, so the fail-safe direction is "alert as before".
 */
import assert from 'node:assert';
import { hostingCheck, normHost } from '../lib/hosts.js';
import { weekKey } from '../lib/buckets.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const OURS = ['tierraencantadafranchise.com', 'www.fmtfranchise.com', 'ivykidsfranchise.com'];

t('a hosted site is ours', () => {
  assert.equal(hostingCheck(OURS).isExternal('tierraencantadafranchise.com'), false);
});

t('www is ignored on both sides of the comparison', () => {
  const h = hostingCheck(OURS);
  assert.equal(h.isExternal('www.tierraencantadafranchise.com'), false);
  assert.equal(h.isExternal('fmtfranchise.com'), false);
});

t('case and scheme do not matter', () => {
  const h = hostingCheck(OURS);
  assert.equal(h.isExternal('IvyKidsFranchise.com'), false);
  assert.equal(normHost('https://IvyKidsFranchise.com:443/x'), 'ivykidsfranchise.com');
});

t('a handed-off site is external', () => {
  assert.equal(hostingCheck(OURS).isExternal('powerliftdoorsfranchising.com'), true);
});

t('isOurs and isExternal never both true', () => {
  const h = hostingCheck(OURS);
  for (const host of [...OURS, 'powerliftdoorsfranchising.com', '']) {
    assert.notEqual(h.isOurs(host), h.isExternal(host), host);
  }
});

t('FAIL SAFE: an empty list treats nothing as external', () => {
  for (const raw of [null, undefined, [], 'not-an-array', {}]) {
    const h = hostingCheck(raw);
    assert.equal(h.known, false, `known should be false for ${JSON.stringify(raw)}`);
    assert.equal(h.isExternal('powerliftdoorsfranchising.com'), false);
    assert.equal(h.isOurs('powerliftdoorsfranchising.com'), true);
  }
});

t('week keys match the format already in KV', () => {
  assert.equal(weekKey('quiet', Date.UTC(2026, 10, 17)), 'quiet:2026-W47');
  assert.equal(weekKey('external', Date.UTC(2026, 0, 1)), 'external:2026-W01');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
