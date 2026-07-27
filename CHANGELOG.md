# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
