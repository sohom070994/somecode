// Edit these, then click "Reload" on the extension at chrome://extensions.
self.SLOT_CONFIG = {
  // Matched (case-insensitive) against the option text of the city dropdown. Checked in turn, one per window.
  // All 5 locations on the portal (OFC page: "CHENNAI VAC"..., consular page: "CHENNAI"...), in priority order. Every check goes through them in this
  // order: scheduled checks, Check now (ticked ones), booking fallback.
  cities: ['NEW DELHI', 'MUMBAI', 'HYDERABAD', 'CHENNAI', 'KOLKATA'],

  // Dates never to book, per page (OFC = /ofc-schedule, CONSULAR = /schedule) and city (keys match
  // `cities`). Format 'YYYY-MM-DD'. Autobook skips these and moves on to the next date; the popup lists them.
  skipDates: {
    OFC: {},
    CONSULAR: {},
  },

  // Consular dates must be within this many weeks after the booked OFC date (avoids a huge gap
  // between the two). 0 = no limit. The popup's dropdown overrides this; the OFC date is filled in
  // when the extension books the OFC, or typed into the popup.
  consularMaxWeeksAfterOfc: 2,

  // Travel windows (inclusive): BOTH appointments must fall inside one of these. OFC dates end
  // consular-limit weeks before each window's end (Jan 31 - 2 weeks = Jan 17), so the consular
  // still fits; consular dates run from the OFC date to OFC + that many weeks, inside the window.
  // Every check uses these, Book now too. The popup shows the resulting OFC / consular ranges.
  dateWindows: [
    { from: '2026-11-10', to: '2027-01-31' },
    { from: '2027-05-01', to: '2027-09-30' },
  ],
  // And never earlier than today + this many days.
  minDaysFromToday: 10,

  // A check starts at these minutes past each hour (local time), only inside activeHours.
  // F1: :15, :25 and :55.
  windowMinutes: [15, 25, 55],
  // Extra check minutes, switchable with the popup's "Also check every 5 min" box (off by default).
  // Together with windowMinutes this is every 5 minutes: :00, :05, :10 ... :55.
  extraWindowMinutes: [0, 5, 10, 20, 30, 35, 40, 45, 50],
  extraWindowsOn: false,
  // windowMinutes that aren't a multiple of 5 - none for F1, so this has no effect.
  offGridWindowsOn: false,
  // Scheduled checks start a uniformly random time in [min, max] seconds after the window minute,
  // picked fresh for each check ([5, 20] -> anywhere from 10:25:05 to 10:25:20). [5, 5] = always 5 s.
  startDelaySeconds: [5, 5],

  // Follow-up checks: after each scheduled check starts, keep checking the ticked cities every
  // `everySeconds` for the next `forMinutes` minutes. Off by default; the popup's "Keep re-checking"
  // box (and its two number boxes) override this and remember the choice. Every follow-up is a full
  // check (calendar requests), so a short gap and a long span mean many more requests and a higher
  // chance of Cloudflare checks / rate limits. Follow-ups stop early on a pause, Turn off or a booking.
  repeatChecks: {
    enabled: true,
    everySeconds: 75,
    forMinutes: 5,
    // Cities the follow-ups check - independent of the popup's regular "Cities to check". null = all
    // cities. Now New Delhi + Mumbai; the popup's "Follow-up cities" ticks override this and are remembered.
    cities: ['NEW DELHI', 'MUMBAI'],
  },

  // A scheduled check that comes due while another run is going waits for it, unless it would
  // start more than this many seconds late (then it is dropped; the next one runs on time).
  queuedCheckMaxSeconds: 60,

  // Session keep-alive: the portal logs you out after ~15 min without activity. If no calendar has
  // loaded for `minutes`, check `city` (book if it can). The dropdown stays on that city.
  // 14, not 15: the timer is checked once a minute, so it fires between 14 and 15 min.
  keepAlive: {
    enabled: true,
    city: 'MUMBAI',
    minutes: 14,
    maxSeconds: 15,              // a keep-alive still waiting on the calendar after this long is cut short (not once it is booking)
    skipWithinSeconds: 60,      // no keep-alive when a scheduled check is due within this long (it keeps the session alive itself)
  },
  // All day: scheduled checks run around the clock (hours on this computer's clock; start
  // inclusive, end exclusive).
  activeHours: { start: 0, end: 24 },

  // Max calendar (schedule-days) requests per day, counting manual city changes too.
  // The portal stops serving the calendar after roughly 15-20 per day.
  dailyCap: 12,
  // Off by default: no daily limit, only the portal's own 429/Cloudflare responses pause checks.
  // The popup's "Ignore daily cap" checkbox overrides this and remembers your choice.
  dailyCapOn: false,

  // Extra wait (random, seconds) after the window minute before a scheduled check.
  // [0, 0] = start the moment the popup countdown reaches zero.
  jitterSeconds: [0, 0],

  // Wait between one city's result and selecting the next city (random, in seconds).
  // Used by every multi-city run: scheduled, Check now, and the booking fallback.
  cityGapSeconds: [2, 5],

  // autoSubmit: pick the earliest matching date + first time and book it (clicks Submit).
  // testMode: true = stop before Submit everywhere. Off: every check and "Book now" submits.
  autoSubmit: true,
  testMode: false,

  // How hard autobook tries once a city has open dates. When many people book the same release
  // the portal answers "The system is processing too many requests" or leaves Submit greyed;
  // autobook then moves on: next time slot -> next date -> next city.
  booking: {
    submitFindWaitMs: 5000,      // slot found but no Submit button yet -> keep looking this long, then next city
    submitEnableWaitMs: 2500,    // Submit still greyed this long after picking a time -> next slot
    responseWaitMs: 120000,      // no answer to Submit in 2 min -> next slot (a late success still counts)
    retryGapMs: 500,           // pause between Submit attempts
    tryOtherCitiesOnFail: true,  // if a city's dates can't be booked, go on to the other cities
  },

  // Alerts: spoken + a "!" badge on the extension icon. Chrome pop-up notifications are off
  // because they cover the booking page.
  desktopNotifications: false,

  // "Log in" / "Answer questions" buttons in the popup. Username, password and the security
  // questions + answers live in .env (same folder). They're only typed into tabs on these sites.
  login: {
    hosts: ['usvisascheduling.com', 'atlasauth.b2clogin.com'],
    submit: true,            // click Submit after filling (false = fill only)
    questionMatchMin: 0.6,   // share of a .env question's words that must appear next to an answer box
  },

  // Page elements, confirmed from snapshots of the live OFC and consular schedule pages (same ids on both):
  //  - datepicker: inline jQuery UI, 2 months, month/year dropdowns; open days are td.greenday
  //  - timeSelect: a <table> of radio buttons (name="schedule-entries", data-slots=N)
  //  - submit: <input type="submit" onclick="onClickSubmit()">
  selectors: {
    citySelect: '#post_select',
    datepicker: '#datepicker',
    timeSelect: '#time_select',
    submit: '#submitbtn',
  },

  // How long to wait for the calendar / time slots to load. The portal can take several minutes;
  // this is only a backstop so a request that never answers can't stall all later checks.
  // Error responses (429, 403, Cloudflare page) are handled the moment they arrive.
  responseTimeoutMs: 10 * 60 * 1000,

  // When the portal pushes back:
  //  - Cloudflare check (403): pause until you tick the box in the recovery window (below) - then
  //    checks resume automatically.
  //  - Rate limited (429 / 1015): pause this many minutes.
  rateLimitPauseMinutes: 120,

  // Log files: every log line is appended to slot-watcher/logs/YYYY-MM-DD.log this often,
  // written directly by native/logger.js (no save dialog). One-time setup: native/install.bat.
  logFiles: {
    enabled: true,
    everyMinutes: 120,
  },

  // Screenshot of the schedule page when a calendar loads with at least one available date (the
  // extension's checks and your own clicks; empty calendars are not captured), saved by
  // native/logger.js to screenshots/YYYY-MM-DD/HH-MM-SS_CITY.jpg.
  // Chrome can only capture the tab showing in its window: a background tab or a minimized window
  // is skipped (with a log line). delayMs: wait for the portal to draw the calendar first.
  screenshots: {
    enabled: true,
    delayMs: 700,
    format: 'jpeg',              // 'jpeg' (smaller) or 'png'
    jpegQuality: 85,
  },

  // Status tab. The portal limits how often the schedule page is LOADED (about 20 a day, then
  // "You have exceeded the limit for viewing this page" for 24 h), not sign-ins or city checks.
  // So the schedule tab is never reloaded or closed. Instead a second, background tab on the portal
  // home page is reloaded before every check (scheduled: leadSeconds early; Check now, Book now,
  // keep-alive: right before, unless it was checked in the last leadSeconds + 90 s):
  //  - home page: fine, the check runs in the schedule tab as usual
  //  - Cloudflare checkbox: the recovery window opens (below); the check runs once it's passed
  //  - sign-in form: Log in + Answer questions in that tab (never Schedule Appointment). The
  //    schedule tab shares its cookies, so it works again without a page load. If its next check
  //    still fails, it's reloaded once.
  // Leave the status tab open; it's reopened if you close it.
  statusTab: {
    enabled: true,
    url: 'https://www.usvisascheduling.com/en-US/',
    leadSeconds: 90,
    loadTimeoutSeconds: 30,      // no answer by then: log it and run the check anyway
    keepAliveByReload: false,    // true: keep-alive reloads the status tab instead of a calendar request (untested)
  },

  // Schedule page loads are counted (popup: "Schedule page loads today"); a warning at warnAt.
  // After the portal's "approaching the maximum" banner the extension loads no schedule page for 24 h.
  pageViews: {
    warnAt: 12,
  },

  // "The requested URL is too long" / "Request Too Long". Every sign-in the portal starts sets a
  // one-time cookie (OpenIdConnect.nonce.*) that's only removed when that sign-in finishes;
  // abandoned sign-ins pile them up until the Cookie header is too big (HTTP 400). A sign-in
  // redirect loop grows the URL instead (HTTP 414). Detected from response codes, the status tab's
  // page text and runaway URLs. Fixes, mildest first, each followed by a status tab reload:
  //  1. remove the leftover sign-in cookies (you stay signed in; Cloudflare clearance kept)
  //  2. remove all portal cookies except Cloudflare's (signs out; the status tab signs back in).
  //     Skipped when allowSignOut is false.
  //  3. pause for pauseMinutes and alert you
  // Before every status check, leftover sign-in cookies beyond maxSignInCookies are removed (the
  // newest are kept, so a sign-in in progress isn't broken). The schedule tab is never reloaded.
  // Separate case, same "URL too long" message: the sign-in site's error UX016. It lost a sign-in
  // (another sign-in started in this browser meanwhile) and redirects to its error page with a whole
  // ~300 KB page in the URL. Not cookies: the status tab starts one fresh sign-in instead, and the
  // log names the code, the transaction and any second sign-in that started in another tab.
  cookieCleanup: {
    enabled: true,
    maxSignInCookies: 3,
    maxUrlLength: 2000,          // a portal / sign-in URL longer than this = redirect loop
    minHeaderBytes: 4096,        // a 400 counts as "too long" only with a Cookie header this big (or too many leftovers)
    allowSignOut: true,
    pauseMinutes: 60,
  },

  // Cloudflare detection (no extra portal requests):
  //  watchResponses: open the recovery window as soon as ANY portal response is flagged
  //    "cf-mitigated: challenge" (your clicks, keep-alive, the extension's checks, the status tab).
  cloudflare: {
    watchResponses: true,
  },

  // Cloudflare checkbox challenge: open a small window on the portal for YOU to tick the box,
  // then close it and resume by itself. The extension never clicks the checkbox (test.bat does,
  // at a fixed spot in this window).
  recoveryWindow: {
    enabled: true,
    // Home page only: it doesn't count toward the schedule-page view limit.
    urls: ['https://www.usvisascheduling.com/en-US/'],
    noChallengeWaitSeconds: 6,   // a URL with no checkbox after this long -> try the next one
    timeoutMinutes: 10,          // remind you if the box isn't ticked by then (stays paused)
    batDelayMs: 1500,            // pause this long after the Cloudflare page shows, then launch test.bat
    stillOpenLogSeconds: 8,     // log a line if the window is still open this long after test.bat ran
    retryAfterPass: true,        // re-run the cities the challenge interrupted
    repeatMinutes: 5,            // challenged again this soon after passing -> logged; the status tab
                                 //   check after the pass signs back in if the session is gone
    width: 520,
    height: 680,
  },

  // Signing back in, in the status tab (and the popup's Test sign-in button): Log in, Answer
  // questions, stop at the portal home page.
  signIn: {
    pageLoadTimeoutSeconds: 30,  // give up if no sign-in / questions page loads within this
    pageDelayMs: [500, 1500],    // random pause after each page loads before acting on it
    // "Schedule Appointment" in the home page's side menu: its presence means "signed in". Clicked
    // only when no schedule tab is open at all.
    scheduleLink: '#continue_application',
  },

};
