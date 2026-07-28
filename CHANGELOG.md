# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.4.0]

### Fixed

- **A Start or End without an offset is now read in the Timezone field's zone,
  not the n8n host's.** `2026-07-29T14:00:00` with Timezone `Europe/Berlin`
  means two o'clock in Berlin; it was previously parsed in the host's zone —
  usually UTC in Docker — and stored two hours out. The same class of error as
  the one fixed in 3.0.0, on the input side, and only when the offset was left
  off.

  This means a caller no longer has to know whether summer time applies. An
  explicit offset, or a trailing `Z`, is still taken at face value.

  If you were compensating by always writing an explicit offset, nothing
  changes. If you passed naive times and corrected for the shift elsewhere,
  remove that correction.

### Changed

- The Start, End, and Timezone descriptions now say so, since those are what an
  AI Agent reads when deciding what to send.

## [3.3.0]

### Added

- **Single occurrences of a recurring series can be changed and cancelled.**
  Set **Occurrence** on Delete or Update to a `recurrenceId` from a read, and
  only that date is affected.

  A series has no per-occurrence resource to address: every occurrence shares
  one UID and one URL. Cancelling therefore adds the slot to `EXDATE` and
  writes the series back — a `PUT`, not a `DELETE`, since deleting the resource
  would take the whole series. Changing writes a `RECURRENCE-ID` override
  beside the master, seeded from it so the occurrence keeps the series' details,
  minus the recurrence properties an override must not carry.

  Both anchor on the slot the rule generated rather than on where an occurrence
  was moved to, so a moved occurrence can still be cancelled afterwards — and
  cancelling removes any override for that slot instead of orphaning it.

### Changed

- The guard added in 3.1.0 now points at both ways out: name an occurrence, or
  confirm the whole series.

## [3.2.0]

### Added

- **`startLocal` and `endLocal`** on returned events: the same moment as the
  event's own local time with its offset applied, `2026-07-28T21:00:00+02:00`.

  `start` is a UTC instant because that is what sorts and computes correctly,
  but reading a local time off it requires knowing the offset in force on that
  date — and language models get that wrong. Asked to show a 19:00Z summer
  event in Berlin, one reported 23:00, then 20:00 on a later run: no offset,
  then the winter offset. For a node that advertises `usableAsTool`, handing
  the model arithmetic it cannot reliably do is a design fault, not the model's
  problem.

  Events stored in plain UTC carry no zone of their own and are rendered in the
  workflow's timezone. All-day events keep their bare date. `start` and `end`
  are unchanged, so nothing that reads them needs to.

- The node description now tells an agent which field to use for what.

## [3.1.2]

### Fixed

- **Events with a TZID were read at the wrong time when the calendar object
  carried a faulty VTIMEZONE.** Infomaniak's own importer writes
  `TZID:Europe/Berlin` with US transition rules whose `RRULE`s contradict their
  own `DTSTART`s. No observance then matches a summer date, ical.js falls back
  to a zero offset, and every affected event is reported two hours late — a
  21:00 pickup shows up as 23:00.

  An IANA `TZID` is now resolved against the platform's timezone database
  rather than the embedded VTIMEZONE, which is written by whichever tool
  produced the event and is wrong often enough to matter. The embedded
  definition remains the fallback for a `TZID` that names no IANA zone, such as
  an Outlook-style `W. Europe Standard Time`.

  Anything read from an affected calendar before this release was wrong by the
  UTC offset in force at the event's date. Reads only — nothing this node wrote
  was affected.

## [3.1.1]

### Fixed

- A reversed or zero-width time window is rejected instead of being sent to the
  server, which answers it with an empty result that reads as "no events" rather
  than as the mistake it is. The error shows both bounds.
- A **Lookahead Days** of zero or less is rejected on Get Next. The field's
  `minValue` constrains the editor, not an expression that computes the value.

### Added

- CI on push and pull requests: build, lint self-test, lint, tests, the offline
  smoke test, and a check on the contents of the published tarball. On a version
  tag, the tag is compared against `package.json`.
- `npm run check:package`, also wired into `prepublishOnly`.
- `engines: node >=20.15`, matching what the shipped code needs. Development
  requires Node 22 — `n8n-workflow` pulls in `isolated-vm`, which will not
  install on 20 — but that does not reach consumers.

## [3.1.0]

### Added

- **Entire Series** toggle on Delete and Update. Every occurrence of a
  recurring event shares one UID and one resource, so deleting "tomorrow's
  standup" by UID removes the whole series. That now has to be asked for: if
  the target turns out to be recurring and the toggle is off, the operation is
  refused and the error names the rule at stake.
- Delete sends `If-Match` with the stored ETag, so an event modified since it
  was read is not removed unseen. A `412` is reported as a conflict rather than
  passed through raw.

### Changed

- **Delete on a recurring event now fails by default.** Previously it removed
  every occurrence silently. Set **Entire Series** to restore the old
  behaviour. Non-recurring events are unaffected.
- Delete reads the event before removing it — one extra request, which is what
  makes both the series check and the conditional delete possible. A missing
  event is now reported as such instead of surfacing as a bare `404`.

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
