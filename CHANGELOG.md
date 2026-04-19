# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] – 2026-04-19

### Breaking
- The monolithic `CalDAV Tool` (`caldavTool`) node is **removed** and
  replaced by **four operation-bound tool nodes**:
  - `CalDAV Get Events Tool` (`calDavGetEventsTool`)
  - `CalDAV Create Event Tool` (`calDavCreateEventTool`)
  - `CalDAV Update Event Tool` (`calDavUpdateEventTool`)
  - `CalDAV Delete Event Tool` (`calDavDeleteEventTool`)

  Each bound tool:
  - advertises a focused zod schema with only the fields relevant to
    its single operation (no more 19-field catch-all schema);
  - hard-codes its `operation` — the LLM cannot override it via
    `operation` / `action` / `tool` / `type` / `method` / `command`;
  - exposes only the matching UI parameters in the n8n editor.

  Upgrade path: replace each `CalDAV Tool` node in existing workflows
  with the matching bound tool. The standard (non-AI) `CalDAV` node is
  unchanged.

### Added
- `nodes/CalDav/helpers/ToolNodeFactory.ts` — shared factory that
  builds the `supplyData` / `execute` pair from a `BoundToolSpec`, so
  the four new node files stay small and identical in behaviour.

### Changed
- User-Agent and iCal `PRODID` bumped to `1.1.0`.

---

## [1.0.3] – 2026-04-19

### Fixed
- `normalizeAgentInput()` now also flattens sibling `parameters` /
  `params` / `args` / `arguments` containers. Some agents emit
  `{ operation: "createEvent", parameters: { start, end, title } }`;
  v1.0.2 only flattened `event` / `eventDetails` / `details`, so the
  event fields were dropped.
- `title` is confirmed as an alias for `eventTitle` (already present
  since 1.0.2 — reinforced by a regression test).

### Changed
- User-Agent and iCal `PRODID` bumped to `1.0.3`.

---

## [1.0.2] – 2026-04-19

### Fixed
- `CalDAV Tool` (`caldavTool`) now tolerates the input shapes real AI
  Agents emit. Previously, calls such as
  `{ operation: "createEvent", event: { start, end, summary } }` produced
  *"Unsupported operation: undefined"* or missing-field errors because
  the tool expected a flat payload with canonical keys.
- New `normalizeAgentInput()` helper
  (`nodes/CalDav/helpers/AgentInput.ts`):
  - unwraps top-level wrappers: `arguments`, `args`, `input`, `data`,
    `payload`, `parameters`;
  - flattens nested containers: `event`, `eventDetails`, `details`,
    `body`, `fields`, `timeRange`, `range`, `period`, `when`,
    `recurrence`, `repeat`, `reminder`, `alarm`;
  - maps common aliases to canonical fields — `summary`/`title`/`name`
    → `eventTitle`, `start`/`startTime`/`startDateTime` →
    `startDateAndTime`, `end`/`endTime`/`endDateTime` →
    `endDateAndTime`, `allDay`/`isAllDay` → `allDayEvent`,
    `notes`/`body` → `description`, `frequency` →
    `recurrenceFrequency`, `interval` → `recurrenceInterval`,
    `count` → `recurrenceCount`, `until` → `recurrenceUntil`,
    `byDay`/`days` → `recurrenceByDay`;
  - accepts JSON strings as well as plain objects.
- Robust operation resolution: the operation is read from
  `operation` / `action` / `tool` / `type` / `method` / `command` with
  whitespace trimming, then falls back to the static node parameter and
  finally to `getEvents`, so the tool never dispatches `undefined`.

### Changed
- User-Agent and iCal `PRODID` bumped to `1.0.2`.

---

## [1.0.1] – 2026-04-19

### Fixed
- `CalDAV Tool` (`caldavTool`) now exposes a full JSON schema to the AI
  Agent by returning a `DynamicStructuredTool` from
  `@langchain/core/tools` with a zod schema. Previous releases returned
  a bare `{ name, description, call }` object, which caused Mistral AI
  to abort with *"Unknown tool type passed to ChatMistral"* and made it
  impossible for any LLM to discover the tool's parameters. Behaviour
  for OpenAI / Anthropic function-calling is also significantly more
  reliable, since each field now carries its own `description`.

### Changed
- `@langchain/core` and `zod` are declared as optional peer dependencies
  (they ship with every n8n instance that has the AI modules enabled,
  so no extra install is needed).

---

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
