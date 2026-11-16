// Edit these, then click "Reload" on the extension at chrome://extensions.
self.SLOT_CONFIG = {
  // Matched (case-insensitive) against the option text of the city dropdown. Checked in turn, one per window.
  // All 5 locations on the portal (OFC page: "CHENNAI VAC"..., consular page: "CHENNAI"...), in priority order. Every check goes through them in this
  // order: scheduled checks, Check now (ticked ones), booking fallback.
  cities: ['HYDERABAD', 'CHENNAI', 'KOLKATA', 'MUMBAI', 'NEW DELHI'],

  // Dates never to book, per page (OFC = /ofc-schedule, CONSULAR = /schedule) and city (keys match
  // `cities`). Format 'YYYY-MM-DD'. Autobook skips these and moves on to the next date; the popup lists them.
  skipDates: {
    OFC: {
      HYDERABAD: ['2027-01-05'],
    },
    CONSULAR: {},
  },

  // Consular dates must be within this many weeks after the booked OFC date (avoids a huge gap
  // between the two). 0 = no limit. The popup's dropdown overrides this; the OFC date is filled in
  // when the extension books the OFC, or typed into the popup.
  consularMaxWeeksAfterOfc: 3,

  // Acceptable appointment range: from today + minDaysFromToday up to latestDate (inclusive).
  // Any date is fine, so the range is effectively open.
  minDaysFromToday: 0,
  latestDate: '2099-12-31',

  // A check starts at these minutes past each hour (local time), only inside activeHours.
  // :25/:55 plus the busiest minutes from the minute-of-hour analysis, converted from India time
  // to US time (+30 min): :53-:03 cluster -> :53 :56 :59 :02; :25-:28 cluster -> :27; extras :14 :44.
  windowMinutes: [2, 14, 25, 27, 44, 53, 55, 56, 59],
  // Extra check minutes, switchable with the popup's "Also check every 5 min" box (on by default).
  // Together with windowMinutes this is every 5 minutes: :00, :05, :10 ... :55.
  extraWindowMinutes: [0, 5, 10, 15, 20, 30, 35, 40, 45, 50],
  extraWindowsOn: true,
  // windowMinutes that aren't a multiple of 5 (:02 :14 :27 ...), switchable with the popup's
  // "Also check at off-5 minutes" box (on by default). :25/:55 always stay on.
  offGridWindowsOn: true,
  // Scheduled checks start a uniformly random time in [min, max] seconds after the window minute,
  // picked fresh for each check ([5, 20] -> anywhere from 10:25:05 to 10:25:20). [5, 5] = always 5 s.
  startDelaySeconds: [5, 5],

  // Session keep-alive: the portal logs you out after ~15 min without activity. If no calendar has
  // loaded for `minutes`, check `city` (book if it can), then go back to the blank city option.
  // 14, not 15: the timer is checked once a minute, so it fires between 14 and 15 min.
  keepAlive: {
    enabled: true,
    city: 'HYDERABAD',
    minutes: 14,
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
  // Used by every multi-city run: scheduled, Check now, WhatsApp, and the booking fallback.
  cityGapSeconds: [3, 10],

  // autoSubmit: pick the earliest matching date + first time and book it (clicks Submit).
  // testMode: true = stop before Submit everywhere. Off: every check and "Book now" submits.
  autoSubmit: true,
  testMode: false,

  // How hard autobook tries once a city has open dates. When many people book the same release
  // the portal answers "The system is processing too many requests" or leaves Submit greyed;
  // autobook then moves on: next time slot -> next date -> next city.
  booking: {
    maxDatesPerCity: 3,          // try this many of the earliest dates in a city
    maxSubmitAttempts: 8,        // Submit clicks per city per check
    submitEnableWaitMs: 2500,    // Submit still greyed this long after picking a time -> next slot
    responseWaitMs: 90000,       // no answer to Submit in 1 min 30 s -> next slot (a late success still counts)
    retryGapMs: 1000,            // pause between Submit attempts
    tryOtherCitiesOnFail: true,  // if a city's dates can't be booked, go on to the other cities
  },

  // Alerts: spoken + a "!" badge on the extension icon. Chrome pop-up notifications are off
  // because they cover the booking page.
  desktopNotifications: false,

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
  //  - Cloudflare check (403): pause until you reload the schedule page, pass the check, and the
  //    calendar loads once - then checks resume automatically.
  //  - Rate limited (429 / 1015): pause this many minutes.
  rateLimitPauseMinutes: 120,

  // Log files: every log line is appended to slot-watcher/logs/YYYY-MM-DD.log this often,
  // written directly by native/logger.js (no save dialog). One-time setup: native/install.bat.
  logFiles: {
    enabled: true,
    everyMinutes: 120,
  },

  // Cloudflare detection (no extra portal requests):
  //  watchResponses: open the recovery window as soon as ANY portal response in the schedule tab
  //    is flagged "cf-mitigated: challenge" (your clicks, keep-alive, the extension's checks).
  //  proactive: when you pass, Cloudflare's cf_clearance cookie says when it expires. If it runs out
  //    within leadSeconds and a check / keep-alive is due within upcomingSeconds, open the window
  //    early so you can tick the box before the check fails. Every pass and challenge is logged
  //    with the cookie's expiry, so the log shows whether that expiry is accurate.
  cloudflare: {
    watchResponses: true,
    proactive: true,
    leadSeconds: 90,
    upcomingSeconds: 150,
  },

  // Cloudflare checkbox challenge: open a small window on the portal for YOU to tick the box,
  // then close it and resume by itself. The extension never clicks the checkbox.
  recoveryWindow: {
    enabled: true,
    // Tried in order until one shows the checkbox. The home page doesn't count toward the portal's
    // schedule-page view limit; the schedule page (second) does.
    urls: ['https://www.usvisascheduling.com/en-US/', 'https://www.usvisascheduling.com/en-US/schedule/'], // consular page (OFC is booked)
    noChallengeWaitSeconds: 6,   // a URL with no checkbox after this long -> try the next one
    timeoutMinutes: 10,          // remind you if the box isn't ticked by then (stays paused)
    retryAfterPass: true,        // re-run the cities the challenge interrupted
    repeatMinutes: 5,            // challenged again this soon after passing ->
    cooldownMinutes: 30,         //   don't reopen the window, pause this long instead
    width: 520,
    height: 680,
  },

  // Watch a WhatsApp Web group (keep that chat OPEN in a web.whatsapp.com tab).
  // Messages are read locally in your browser; nothing is sent anywhere.
  whatsapp: {
    enabled: true,
    groupName: 'India - H-1b/H4 slots', // matched against the open chat's header (substring)
    triggerCheck: true,           // check a mentioned city immediately (uses the daily budget)
    freshMinutes: 10,             // ignore messages older than this
    cityCooldownMinutes: 5,       // don't re-check the same city from alerts more often than this
    // Keys must match `cities` above. Words are matched as whole words, case-insensitive.
    cityAliases: {
      CHENNAI: ['chennai', 'madras'],
      HYDERABAD: ['hyderabad', 'hyd'],
      KOLKATA: ['kolkata', 'calcutta'],
      MUMBAI: ['mumbai', 'bombay'],
      'NEW DELHI': ['new delhi', 'delhi'],
    },
    // Messages matching this are ignored (e.g. "no slots in Chennai").
    ignorePattern: '\\bno slots?\\b|not available|\\bgone\\b|\\b0 slots?\\b',
  },
};
