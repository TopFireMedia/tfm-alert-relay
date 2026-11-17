/**
 * Which hosts belong in the fleet monitor.
 *
 * Anything running the TFM plugin can register itself by sending a heartbeat,
 * and three separate things have joined the fleet that way without anyone
 * meaning them to:
 *
 *   - a developer's local copy of Johnny Bronx, downloaded to a laptop (Nov 4)
 *   - durafleet.wpenginepowered.com and durafleetstg.wpenginepowered.com,
 *     WP Engine internal hostnames for installs we no longer serve (Nov 6)
 *
 * Each then generated false "Site Down" alerts forever, because a laptop that
 * gets shut down or a migrated-away install that stops heartbeating looks
 * exactly like a production site falling over.
 *
 * The rule is deliberately about the *hostname*, not about reachability: a
 * local copy may well answer a ping from the developer's machine, and a stale
 * WP Engine install answers fine too. What makes them wrong is that they are
 * not the address a customer would ever visit.
 *
 * `*.wpenginepowered.com` is in the list because it is WP Engine's internal
 * hostname for an install. A WP Engine site we genuinely monitor should be
 * registered under its own domain, which is what the plugin reports when the
 * site is configured properly.
 *
 * MONITOR_IGNORE_HOSTS (comma separated) adds one-offs without a deploy.
 * Entries starting with "." match any subdomain, so ".example.com" covers
 * "a.example.com" but not "example.com".
 */

const NON_PRODUCTION = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,            // mDNS / MAMP / Local by Flywheel
  /\.test$/i,             // RFC 6761 reserved
  /\.invalid$/i,
  /\.example$/i,
  /\.wpenginepowered\.com$/i,   // WP Engine internal install hostname
  /\.ngrok(-free)?\.(io|app|dev)$/i,
  /\.trycloudflare\.com$/i,
  /\.lhr\.life$/i,
  /\.loca\.lt$/i,
];

/** Bare IPv4, and anything inside RFC1918 / loopback / link-local. */
function isIpLiteral(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return host.includes(':'); // IPv6 literal
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a > 255 || b > 255) return false;
  return true;
}

export function ignoreReason(host) {
  if (!host) return 'empty host';
  const h = String(host).toLowerCase().replace(/:\d+$/, '');

  const extra = (process.env.MONITOR_IGNORE_HOSTS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const e of extra) {
    if (e.startsWith('.') ? h.endsWith(e) : h === e) return `MONITOR_IGNORE_HOSTS (${e})`;
  }

  if (isIpLiteral(h)) return 'IP literal, not a customer-facing hostname';
  if (!h.includes('.')) return 'no dot, not a public hostname';
  for (const re of NON_PRODUCTION) {
    if (re.test(h)) return `non-production hostname (${re.source})`;
  }
  return null;
}

/** True when this host should take part in uptime monitoring and alerting. */
export function isMonitorable(host) {
  return ignoreReason(host) === null;
}

/** Normalise a hostname the way the Plesk host list stores them. */
export function normHost(h) {
  return String(h || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/^www\./, '');
}

/**
 * Is this site hosted by us, according to the authoritative Plesk host list?
 *
 * Sites we handed off keep running the TFM plugin, because too much of the build
 * depends on it to pull it out, so they carry on reporting events to us forever.
 * PowerLift is the case that prompted this: handed over to Onsharp, moved to
 * their own LiteSpeed box, and still posting "User Deleted" alerts into
 * Site-Alerts months later. The channel is for sites we can actually act on, so
 * anything we do not host is tallied for the digest instead of posted.
 *
 * Matched on hostname, not IP, so a Cloudflare-proxied site on our box is still
 * recognised as ours.
 *
 * Fails safe in the direction that keeps alerting: when the list is missing or
 * empty we cannot tell who hosts what, so nothing is treated as external and
 * behaviour is exactly as it was. An empty list must never be able to silence
 * the whole fleet - that failure would be invisible, which is the worst kind
 * here, and this relay has already had one silent two-month outage.
 */
export function hostingCheck(onServerRaw) {
  const set = new Set((Array.isArray(onServerRaw) ? onServerRaw : []).map(normHost));
  const known = set.size > 0;
  return {
    known,
    isOurs: (host) => !known || set.has(normHost(host)),
    isExternal: (host) => known && !set.has(normHost(host)),
  };
}
