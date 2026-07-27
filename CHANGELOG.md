# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0]

The first release since 2.6.1. Versions 2.7.0 through 2.11.0 were developed but
never published; their entries are kept below for traceability. If you are
upgrading from 2.6.x, this section is what matters.

### BREAKING CHANGES

1. **`start` and `end` changed format.** Timed events previously reported a
   local wall clock with no offset (`2026-04-20T14:00:00`), which downstream
   nodes re-read in the n8n host's timezone. They are now explicit UTC instants
   (`2026-04-20T12:00:00.000Z`); all-day events report a bare date
   (`2026-04-20`). Both sort correctly as strings. Any expression that compares,
   slices, or parses these values needs review.

2. **`raw` is no longer returned by default.** Read operations have a
   **Simplify** toggle, on by default, which omits the full `VCALENDAR` source.
   Turn it off where you depend on `raw`.

3. **Update no longer creates a missing event.** It reads the stored object
   first in order to preserve fields you did not supply, so a missing event is
   now an error instead of a silent create. Use Create for that.

4. **Events are written at different times than before — this is the fix, but
   it will move existing workflows.** With **Timezone** set, 2.6.x emitted the
   n8n host's wall clock under the requested `TZID`, shifting every event by the
   host's UTC offset (two hours on a UTC host writing `Europe/Berlin`). All-day
   events were written one calendar day early. If you compensated for either by
   pre-shifting your input, remove that workaround or events will now be wrong
   in the other direction.

5. **All-day `DTEND` is now the exclusive end RFC 5545 requires.** A same-day
   or end-of-day range used to encode a zero-length event; it now produces a
   one-day event.

### Added

- Recurring series are expanded into the occurrences inside the queried window,
  honouring `EXDATE` and `RECURRENCE-ID` overrides.
- Events can be addressed by **Event URL** as well as UID, and a UID is
  resolved against the server — so events created in Thunderbird, Apple
  Calendar, or a web UI can be reached at all.
- Calendars report `readOnly`, and read-only ones are marked 🔒 in the dropdown.
- `recurrenceId` and `timezone` on returned events.
- A test suite: 80 unit and integration tests, plus a smoke test that runs
  against a real server and one that runs offline.

### Fixed

- Update preserves everything it was not asked to change, including properties
  this node does not model (`CATEGORIES`, `ORGANIZER`, custom `X-` properties),
  and is guarded by `If-Match` against concurrent edits.
- A `TZID` with no accompanying `VTIMEZONE` is resolved against the named IANA
  zone instead of the host's.
- Writing to a read-only calendar explains itself instead of returning n8n's
  generic "check your credentials".

### Security

- Advisories affecting installed users: **0**. `fast-xml-parser` moves 4 → 5.

## [2.11.0]

### Added

- Calendars report **`readOnly`**, taken from the server's
  `current-user-privilege-set`. It rides along on the listing discovery already
  performs, so it costs no extra request.
- Read-only calendars are marked `🔒 … (Read-Only)` in the Calendar dropdown
  and sorted after the writable ones.

### Fixed

- Writing to a calendar you cannot write to produced n8n's generic
  `Forbidden - perhaps check your credentials?`, which points at the wrong
  cause entirely. Such a 403 now explains that the calendar is read-only —
  typically one shared with you, or a subscribed feed — and how to find one
  that is not.

### Notes

- A server that does not report privileges leaves `readOnly` undefined rather
  than assuming read-only, so nothing is mislabelled or blocked on servers
  without the property.
- Found by running the smoke test against a real account, where five of six
  calendars turned out to be read-only while looking identical in the dropdown.

## [2.10.0]

### Changed

- **gulp removed.** A single task copied one SVG into the build output; gulp 4
  is end-of-life and pulled in gulp-cli, liftoff, matchdep, chokidar, and
  micromatch to do it. Replaced by `scripts/copy-icons.mjs`, which reproduces
  the previous behaviour exactly.
- **ESLint 8 → 9**, with a flat config (`eslint.config.mjs`) replacing
  `.eslintrc.js`. `@typescript-eslint/parser` moves 7 → 8.
- **`fast-xml-parser` 4 → 5** — a runtime dependency, and the only advisory
  that reached installed users.

### Added

- `npm run lint:selftest`, which feeds a deliberate violation to each
  eslint-plugin-n8n-nodes-base preset and fails if it goes unreported. Part of
  `prepublishOnly`.

### Removed

- The plugin's `community` preset (19 rules against `package.json`) is no
  longer configured. Its rules visit `ObjectExpression` while the JSON parser
  emits `JSONObjectExpression`, so they never matched — verified inert under
  ESLint 8 and 9 and under plugin 1.16.6 and 1.16.7. It was never enforcing
  anything; the configuration only made it look as though it was.

### Security

- Advisories affecting installed users: **0** (was 1 moderate). Development
  advisories drop from 24 to 5, all in ESLint's own `minimatch` chain. ESLint 10
  would clear those but crashes eslint-plugin-n8n-nodes-base during traversal,
  so the project stays on 9.

## [2.9.2]

### Added

- `LICENSE` file. The package declared MIT but shipped no licence text.
- `CHANGELOG.md` is now included in the published package.

### Fixed

- `dist/tsconfig.tsbuildinfo`, a 64 kB incremental build cache, was published
  with every release. The package is now 37 kB instead of 54 kB.

## [2.9.1]

### Added

- Calendar discovery is memoised per execution. A batch of input items used to
  repeat the full PROPFIND chain for every item; it now runs once.
- `Time Min` / `Time Max` are validated, so an unparseable date fails with a
  message naming the field instead of an opaque `400` from the server.
- Integration tests covering the read operations end to end against a fake
  CalDAV server.

### Changed

- Internal: `Get Many`, `Get Next`, and `Search` now share one implementation
  and differ only in the time window and filter predicate.

## [2.9.0]

### Added

- **Event URL** field on `Get`, `Update`, `Delete`, and `Move`. Read operations
  already return `url`; passing it through addresses the event directly.
- When only a UID is known, the event is located with a `calendar-query` on the
  UID, falling back to the historical `<calendar>/<uid>.ics` convention.
- **Simplify** toggle on the read operations, on by default.

### Fixed

- `Get` / `Update` / `Delete` / `Move` could only reach events created by this
  node. Events added in Thunderbird, Apple Calendar, or a web UI are stored
  under a filename the server chose, so addressing them by UID returned `404`.

### Changed

- **Event UID** is no longer mandatory — either UID or URL identifies an event.
- `raw` is omitted by default. Turn **Simplify** off to restore it.

## [2.8.0]

### Added

- Recurring series are expanded into the individual occurrences that fall
  inside the queried window, honouring `EXDATE` exclusions and `RECURRENCE-ID`
  overrides.
- `recurrenceId` and `timezone` fields on returned events.

### Fixed

- A series reported its original `DTSTART` rather than the occurrence in the
  requested window, and `Get Next` skipped recurring events entirely.
- A `TZID` without an accompanying `VTIMEZONE` was read in the n8n host's
  timezone. Such times are now resolved against the named IANA zone.
- Reading an object whose overridden instance was serialised first returned the
  override instead of the series master.

### Changed

- **`start` / `end` output format.** Timed events previously reported a local
  wall clock with no offset (`2026-04-20T14:00:00`), which downstream nodes
  re-read in the host's timezone. They are now explicit UTC instants
  (`2026-04-20T12:00:00.000Z`); all-day events report a bare date
  (`2026-04-20`). Both sort correctly as strings.

## [2.7.0]

### Fixed

- **Timed events were written at the wrong time.** With **Timezone** set, the
  n8n host's wall clock was emitted under the requested `TZID`, shifting every
  event by the host's UTC offset — two hours on a UTC host writing
  `Europe/Berlin`. Events created with an earlier version should be re-checked.
- **All-day events were written one day early**, because the date was taken
  from the instant's UTC components.
- All-day `DTEND` is now the exclusive end RFC 5545 requires. An inclusive
  same-day end produces a one-day event instead of a zero-length one.
- **`Update` no longer discards data.** It rebuilt the event from the node's
  own fields, dropping everything not restated — description, location,
  attendees, reminders, recurrence — along with properties this node does not
  model at all (`CATEGORIES`, `ORGANIZER`, custom `X-` properties). Updates are
  now applied as a patch to the stored object.

### Added

- `If-Match` on update, so a concurrent edit is rejected rather than
  overwritten.
- `SEQUENCE` is incremented and `LAST-MODIFIED` set on every update, so clients
  recognise the change.
- Unit test suite (`npm test`, Vitest). Tests assert that output is identical
  across several host timezones — the class of bug fixed in this release.

### Changed

- `Update` fails when the event does not exist instead of silently creating it.
- iCalendar is serialised through ical.js, which brings RFC-compliant line
  folding and parameter quoting.

## [2.0.0]

Initial release.
