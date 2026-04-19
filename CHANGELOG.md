# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] – 2026-04-19

Initial release.

### Added
- `CalDAV` standard node with five operations:
  `Get Events`, `Create Event`, `Update Event`, `Delete Event`,
  `Get Free/Busy`.
- `CalDAV Tool` AI Agent node variant:
  - Every enum field is a free-form string so `$fromAI()` values pass
    n8n validation regardless of casing.
  - Parameter normalisation: `camelCase`, `Underscore_Case`,
    `UPPER_CASE`, `kebab-case` are all accepted and canonicalised.
  - Error handling defaults to `returnError` so a tool failure never
    aborts the surrounding Agent loop.
- `CalDAV API` credential (Basic auth) with `PROPFIND` connection test.
- Dynamic VTIMEZONE generation with DAYLIGHT + STANDARD components,
  correct DST rules for Europe, North America, Australia, New Zealand
  and Chile; single STANDARD component for non-DST zones.
- RFC 5545 compliant iCal emission: CRLF line endings, 75-octet line
  folding, correct property ordering (VTIMEZONE before VEVENT), UTC
  DTSTAMP/CREATED/LAST-MODIFIED, TZID-qualified DTSTART/DTEND.
- VALARM emission when `Reminder` minutes > 0.
- RRULE support for DAILY/WEEKLY/MONTHLY/YEARLY, with
  COUNT / UNTIL / BYDAY including ordinal tokens (`2MO`, `-1FR`).
- Client-side recurrence expansion so query results are uniform across
  server implementations.
- Free/Busy via `free-busy-query` with automatic fallback to
  `calendar-query` when the server does not honour it.
- Security hardening: UID sanitisation (`[^\w\-.@]` → `_`), path
  traversal guard (`..`, `//`, control chars), input escaping for all
  TEXT iCal properties, no credential or response-body logging.
- Unit tests for parameter normalisation, iCal escaping / folding,
  VTIMEZONE (Berlin, UTC, Tokyo, New York), RRULE building, VEVENT
  parsing, recurrence expansion, free/busy fallback and structured
  error payloads.
- README with Infomaniak, Nextcloud, iCloud, Radicale examples and a
  complete AI Agent setup guide with a suggested system prompt.
