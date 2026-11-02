/**
 * Domain and hosting access watcher - runs inside analytics@topfiremedia.com.
 *
 * Posts to the relay, which posts to the Site-Alerts channel. Lives in the
 * mailbox rather than polling it from outside so that no Gmail credential
 * exists anywhere else: no app password, no OAuth refresh token in Vercel.
 *
 * ## Setup
 *
 * 1. Sign in as analytics@topfiremedia.com, go to script.google.com, new project.
 * 2. Paste this file in.
 * 3. Project Settings -> Script Properties, add:
 *      RELAY_URL   https://<relay-host>/api/mail-alert
 *      MAIL_TOKEN  <same value as MAIL_ALERT_TOKEN in Vercel>
 * 4. Run `dryRun` once. It posts nothing and logs what it would have sent.
 *    Read that output before going further - it is the only way to see this
 *    mailbox's real volume.
 * 5. When the output looks right, add a time-driven trigger on `watchAccessMail`,
 *    every 15 minutes.
 *
 * ## Why the sender list is the primary filter
 *
 * The relay classifies on subject wording, but wording alone is far too broad to
 * use on a whole mailbox: a search of ssimpson@ for phrases like "invited you"
 * and "access granted" returned mostly Asana task shares and Figma file invites.
 * Those are real invitations, just not to anything we host. So this script gates
 * on sender first and lets the relay decide grant vs revocation second.
 *
 * Add vendors here as they come up. The cost of a missing vendor is a missed
 * alert; the cost of a wrong one is channel noise, which is what killed the
 * previous alerting.
 */

var VENDORS = [
  'godaddy.com',
  'networksolutions.com',
  'namecheap.com',
  'name.com',
  'dynadot.com',
  'enom.com',
  'tucows.com',
  'register.com',
  'domain.com',
  'squarespace.com',
  'wix.com',
  'wpengine.com',
  'kinsta.com',
  'siteground.com',
  'bluehost.com',
  'hostgator.com',
  'cloudflare.com',
  'netlify.com',
  'ionos.com',
  'vercel.com'
];

/** How far back each run looks. Generous: the relay dedupes on message id. */
var WINDOW_DAYS = 2;

function buildQuery_() {
  var from = VENDORS.map(function (v) { return 'from:' + v; }).join(' OR ');
  return '(' + from + ') newer_than:' + WINDOW_DAYS + 'd';
}

/**
 * Subject pre-filter, kept loose on purpose.
 *
 * The relay holds the real classifier, and it is the one place that decision
 * should live - this only avoids POSTing obvious marketing. Anything that gets
 * through here and is not an access event is answered with "skipped" and costs
 * one request.
 */
function looksRelevant_(subject) {
  return /access|invit|delegat|collaborat|granted|removed|revoked|permission|added you/i.test(subject || '');
}

function collect_() {
  var threads = GmailApp.search(buildQuery_(), 0, 100);
  var out = [];
  for (var i = 0; i < threads.length; i++) {
    var msgs = threads[i].getMessages();
    for (var j = 0; j < msgs.length; j++) {
      var m = msgs[j];
      var subject = m.getSubject();
      if (!looksRelevant_(subject)) continue;
      out.push({
        message_id: m.getId(),
        subject: subject,
        from: m.getFrom(),
        date: Utilities.formatDate(m.getDate(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'),
        link: 'https://mail.google.com/mail/u/0/#all/' + m.getId(),
        mailbox: Session.getActiveUser().getEmail()
      });
    }
  }
  return out;
}

/**
 * Logs what would be sent, sends nothing. Run this first.
 *
 * Widen the window here rather than in WINDOW_DAYS so a one-off look back over
 * several months does not change what the scheduled run does.
 */
function dryRun() {
  var saved = WINDOW_DAYS;
  WINDOW_DAYS = 400;
  try {
    var items = collect_();
    Logger.log('query: ' + buildQuery_());
    Logger.log('candidates: ' + items.length);
    for (var i = 0; i < items.length; i++) {
      Logger.log('  [' + items[i].date + '] ' + items[i].from + ' | ' + items[i].subject);
    }
  } finally {
    WINDOW_DAYS = saved;
  }
}

function watchAccessMail() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('RELAY_URL');
  var token = props.getProperty('MAIL_TOKEN');
  if (!url || !token) throw new Error('RELAY_URL and MAIL_TOKEN must be set in Script Properties');

  var items = collect_();
  var posted = 0, skipped = 0, failed = 0;

  for (var i = 0; i < items.length; i++) {
    try {
      var res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-mail-token': token },
        payload: JSON.stringify(items[i]),
        muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      if (code >= 200 && code < 300) {
        var body = JSON.parse(res.getContentText() || '{}');
        if (body.posted) posted++; else skipped++;
      } else {
        failed++;
        Logger.log('relay ' + code + ' for "' + items[i].subject + '": ' + res.getContentText().slice(0, 200));
      }
    } catch (e) {
      /*
       * One bad message must not stop the run. A thrown error here would leave
       * every later message in the batch unsent until the next trigger, and on a
       * 15 minute trigger that is a silent gap nobody would notice.
       */
      failed++;
      Logger.log('error on "' + items[i].subject + '": ' + e);
    }
  }
  Logger.log('candidates ' + items.length + ' | posted ' + posted + ' | skipped ' + skipped + ' | failed ' + failed);
}
