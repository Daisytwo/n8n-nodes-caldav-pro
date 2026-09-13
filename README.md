# n8n-nodes-caldav-pro

[![CI](https://github.com/Daisytwo/n8n-nodes-caldav-pro/actions/workflows/ci.yml/badge.svg)](https://github.com/Daisytwo/n8n-nodes-caldav-pro/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/n8n-nodes-caldav-pro)](https://www.npmjs.com/package/n8n-nodes-caldav-pro)

A community node for [n8n](https://n8n.io) that connects your workflows to any **CalDAV calendar** — Infomaniak, NextCloud, iCloud, Fastmail, Synology, SOGo, Radicale, and any other RFC 4791-compliant server.

Drop it into a workflow to read, create, update, or delete calendar events — or let an **AI Agent** use it as a tool and manage your calendar from a chat prompt.

## What this node does

This node gives n8n a full CRUD interface to CalDAV calendars. In practical terms:

- **List your calendars** — auto-discovers every calendar on the server via CalDAV's well-known endpoints. No hard-coded URLs. Calendars you cannot write to — ones shared with you, or subscribed feeds like holiday calendars — are reported as `readOnly` and marked 🔒 in the dropdown, so a write does not fail with an unexplained 403.
- **Create events** with title, start/end (ISO 8601 with timezone), description, location, attendees, recurrence (RRULE), and multiple reminders (VALARM).
- **Fetch events** for any time window via server-side `REPORT` queries — fast even on calendars with thousands of events.
- **Expand recurring series** — a weekly meeting is returned as the individual occurrences that fall inside your window, with `EXDATE` exclusions and moved instances (`RECURRENCE-ID`) applied.
- **Update events** — change time, location, reminders, attendees. Updates are applied as a patch: fields you don't supply keep their stored value, including properties this node doesn't model (categories, organiser, custom `X-` properties).
- **Delete events** by UID or URL.
- **Change or cancel a single occurrence** of a recurring series — pass the `recurrenceId` a read returned. Cancelling adds an `EXDATE`; changing writes a `RECURRENCE-ID` override. The rest of the series is untouched.
- **Address events written by other clients** — Get / Update / Delete / Move accept either the event's URL (as returned by every read operation) or its UID, which is resolved against the server. Events created in Thunderbird, Apple Calendar, or a web UI are stored under a filename the server chose, not under their UID.
- **Round-trip iCalendar** — events you write come back correctly parsed, including RRULE, TZID, and alarms.
- **Use it as an AI Agent tool** — every field has an LLM-readable description with examples. Connect one tool node per action with Resource and Operation fixed; the agent fills the value parameters. See [AI Agent Usage](#ai-agent-usage).

### Typical use cases

- **Telegram / Slack → Calendar**: a chat bot powered by an AI Agent creates meetings from natural-language messages ("Kickoff morgen 14 Uhr mit Alice und Bob, erinnere mich 15min vorher").
- **Form submission → Booking**: a customer form in n8n creates an appointment event and sends a confirmation email.
- **CRM sync**: mirror deal-related meetings into a shared CalDAV calendar.
- **Reminder automation**: daily query of tomorrow's events, then send a summary via email / Slack / Telegram.
- **Cross-calendar migration**: read events from one server and write them to another.

## Supported operations

| Resource | Operations                                | Notes                                               |
| -------- | ----------------------------------------- | --------------------------------------------------- |
| Calendar | Get Many                                                        | Lists every calendar available to the user                          |
| Event    | Create · Get · Get Many · Get Next · Search · Update · Move · Delete | Full CRUD, cross-calendar reads, and recurrence expansion       |

### Event output format

Read operations (`Get`, `Get Many`, `Get Next`, `Search`) return:

| Field                  | Value                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `start` / `end`        | All-day: `2026-04-20`. Timed: an ISO 8601 UTC instant, `2026-04-20T12:00:00.000Z`. Use for sorting and arithmetic. |
| `startLocal` / `endLocal` | The same moment as the event's own local time, offset applied: `2026-04-20T14:00:00+02:00`. Use for display. |
| `timezone`             | The `TZID` the event is stored under, when it has one (e.g. `Europe/Berlin`).                |
| `allDay`               | `true` for date-only events.                                                                 |
| `recurrenceId`         | Present only on an occurrence of a recurring series, identifying which slot it is.           |
| `uid` / `url`          | Shared by every occurrence of a series.                                                      |
| `rrule`                | The series rule, repeated on each occurrence.                                                |
| `raw`                  | The full `VCALENDAR` source — only when **Simplify** is turned off.                          |

> Added in 3.2.0: `startLocal` / `endLocal`. Reading a local time off a UTC
> instant means knowing the offset in force on that date, and language models
> get that wrong — asked to show a 19:00Z summer event in Berlin, one reported
> 23:00 and, on a later run, 20:00. These fields do the arithmetic so the agent
> does not have to. Events stored in plain UTC are rendered in the workflow's
> timezone.

> Changed in 2.9.0: read operations have a **Simplify** toggle, on by default, which omits `raw`. A recurring series repeats the same full `VCALENDAR` on every expanded occurrence, so leaving it in bloats the output and — when the node is used as an AI Agent tool — burns context. Turn Simplify off to get the old payload back.

> Changed in 2.8.0: timed events previously reported `start` as a local wall clock with no offset (`2026-04-20T14:00:00`), which downstream nodes re-read in the n8n host's timezone. Times are now emitted as explicit UTC instants and sort correctly.

### Event fields supported

- **Core**: summary, start, end, all-day
- **Details**: description, location
- **Timezone**: IANA TZID (e.g. `Europe/Berlin`) attached to DTSTART/DTEND for correct display across clients
- **Attendees**: multiple email + optional name per event
- **Recurrence**: RRULE (RFC 5545 string, e.g. `FREQ=WEEKLY;BYDAY=MO`)
- **Reminders (VALARM)**: multiple alarms per event, configurable minutes-before and action (Display / Email)
- **Custom UID**: override the auto-generated UUID on create if you need a deterministic identifier

## Upgrading from 2.6.x

3.0.0 fixes several bugs that silently produced wrong data, so events are now
written and reported differently. Read
[CHANGELOG.md](CHANGELOG.md) before upgrading a live workflow — in short:

- `start` / `end` are now UTC instants (`2026-04-20T12:00:00.000Z`) or bare
  dates for all-day events, not offsetless local times.
- `raw` is omitted unless you turn **Simplify** off.
- **Update** no longer creates an event that does not exist.
- Events with a **Timezone** were previously written shifted by the n8n host's
  UTC offset, and all-day events one day early. Both are fixed — if you worked
  around either by adjusting your input, remove that adjustment.

## Installation

### n8n Community Nodes (recommended)

In n8n → **Settings → Community Nodes → Install**, enter:

```
n8n-nodes-caldav-pro
```

### Local development / `npm link`

```bash
# Build the node package
cd n8n-nodes-caldav-pro
npm install
npm run build
npm link

# Link it into your n8n custom folder
mkdir -p ~/.n8n/custom
cd ~/.n8n/custom
npm link n8n-nodes-caldav-pro

# Restart n8n — the node appears as "CalDAV"
n8n start
```

## Infomaniak Quickstart

> Verified against **Infomaniak Workspace** on `sync.infomaniak.com` — see [Tested with](#tested-with).

### Step 1 — Find your short username

Infomaniak's CalDAV username is **NOT** your email address. Go to
**https://config.infomaniak.com/** → scroll to *Thunderbird* or *Apple profile*.
You'll see your short username, e.g. `abc12345`.

> *(Screenshot placeholder: `config.infomaniak.com` page showing the short username.)*

### Step 2 — Generate an app password (only if 2FA is enabled)

If you have 2FA enabled, regular login passwords are rejected for CalDAV. Create an app password at
**https://manager.infomaniak.com** → top-right avatar → **Account management** →
**Security** → **Application passwords** → *Generate new*.
Name it `n8n-caldav`.

### Step 3 — Create the credential in n8n

1. In n8n, add a **CalDAV API** credential.
2. **Server URL**: `https://sync.infomaniak.com/`
3. **Username**: your short username from Step 1 (e.g. `abc12345`) — **not the email**.
4. **Password**: the app password from Step 2 (or your regular password if 2FA is off).
5. Click **Test**. A 207 Multi-Status confirms it works.

### Step 4 — Your first event

1. Drop a **CalDAV** node on the canvas.
2. Select **Resource** = `Event`, **Operation** = `Create`.
3. Pick a calendar from the dropdown (loaded dynamically via discovery).
4. Fill **Summary**, **Start**, **End** — set **Timezone** to `Europe/Berlin` for correct display.
5. Execute. You'll get back `{ uid, url, etag, ... }`.
6. Verify in your calendar app (Thunderbird, Apple Calendar, or https://calendar.infomaniak.com/).

### FAQ — Infomaniak specifics

**1. "401 Unauthorized"** — the Username field contains your email address. Use the short username from https://config.infomaniak.com/ (format: letters + digits, e.g. `abc12345`).

**2. "No calendars found"** — wrong or mistyped Server URL. Must be exactly `https://sync.infomaniak.com/` with trailing slash.

**3. "2FA blocks login"** — regular passwords are refused when 2FA is active. Create an app password at https://manager.infomaniak.com → Security → Application passwords.

**4. "Event shows in wrong timezone (UTC / GMT+00:00)"** — set the **Timezone** field on the event (e.g. `Europe/Berlin`). Otherwise the event is stored as UTC and some clients display it literally.

> Versions before 2.7.0 additionally shifted timed events by the *n8n host's* UTC offset whenever **Timezone** was set, and wrote all-day events on the wrong calendar date. If you created events with an older version, re-check their times.

## External ICS / WebCal Feeds (Read-Only)

Use **Resource** = `ICS Feed (Read-Only)` for subscribed calendars that are not
exposed as CalDAV collections — for example Foodsharing, school holidays,
club schedules, or public holiday feeds. It supports **Get Many**, **Get Next**,
and **Search**; writing, moving, or deleting a feed event is intentionally not
available.

1. Create an **ICS Feed API** credential.
2. Paste the subscription link into **Feed URL**. `https://`, `webcal://`, and
   `webcals://` links are supported; `webcal` is retrieved via HTTPS.
3. Optionally set **Feed Name** (for example `Foodsharing`). It is returned as
   `feedName` with every event, while the subscription URL is never exposed in
   output or error messages.
4. Select the `ICS Feed (Read-Only)` resource and one of the read operations.

> Treat the subscription link like a password: it commonly contains a personal
> token that grants read access to the whole calendar. It belongs only in the
> ICS Feed credential, never in a node field, workflow JSON, log, or chat.
>
> For SSRF safety, the node accepts public HTTPS hostnames on port 443 only and
> rejects local/private names, IP addresses, custom ports, and redirects to a
> different origin. DNS rebinding cannot be fully prevented in a Node.js client;
> restrict outbound network access from your n8n host if untrusted users can
> edit feed credentials.

## AI Agent Usage

The node is declared `usableAsTool: true`. Connect a **separate tool node for each
action** you want the agent to use, for example `Find events` (Event → Search),
`Create event` (Event → Create), and `Read feed` (ICS Feed → Get Many).
**Resource and Operation must remain fixed** in each tool: these routing fields
have `noDataExpression: true`. Do not put `$fromAI()` or other expressions in them.
The agent chooses among the connected tools, not a dynamic resource/operation.

Configure each tool in the editor:

1. Select its fixed Resource and Operation and give it a clear name/description.
2. For Calendar/Event select **CalDAV API**; **ICS Feed API** can be empty.
   For ICS Feed select **ICS Feed API**; **CalDAV API** can be empty.
3. For Event, select a specific Calendar, or choose **Default Calendar** and
   configure the credential's **Default Calendar** hint. This is not the first
   dropdown entry or the first discovered calendar. `getCalendars` loads editor
   options; it is not a tool the agent can call. If needed, expose a separate
   Calendar → Get Many tool for calendar discovery.
4. Use the editor's **Let the model define this parameter** option or `$fromAI()`
   only on supported, expression-capable **value parameters** of the selected
   action. Keep credentials, URLs and routing under your control. Do not assume
   an entire collection (attendees, reminders, or additional fields) can be
   AI-filled: configure its structure in the editor and use supported leaf fields.

For a fixed **Event → Create** tool, example value expressions are:

```javascript
// Summary
{{ $fromAI('summary', 'Event title confirmed by the user', 'string') }}
// Start
{{ $fromAI('start', 'Confirmed start as ISO 8601 with timezone offset', 'string') }}
// End
{{ $fromAI('end', 'Confirmed end as ISO 8601 with timezone offset, after start', 'string') }}
```

Set Calendar and, for example, Additional Fields → Timezone = `Europe/Berlin`
yourself. Configure optional attendee/reminder fields explicitly if needed.
For Search or Get Many supply a valid Time Min/Time Max window; do not replace
missing or invalid dates with silent defaults. For Update, leave both Start and
End unset when changing only the title; supply both when moving the appointment.

### Recommended system prompt

```
You are a calendar assistant with separate tools for specific calendar actions.

- Choose the tool whose fixed action matches the request.
- Convert confirmed dates to ISO 8601 with the correct Europe/Berlin offset.
  Current time: {{ $now.toISO() }}.
- Use startLocal/endLocal from read results when displaying event times.
- Before creating: confirm title, start and end in one short sentence.
- Before deleting: confirm the event and whether one occurrence or the series.
- If the date or intended calendar is unclear, ask rather than guess.
- Use the calendar configured in the tool. Do not invent calendar URLs.
```

## Tested with

| Provider                 | Status               | Notes                                                                                                                                                              |
| ------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Infomaniak Workspace** | ✅ Verified          | Full smoke test passes against a live account (SabreDAV backend) — see below.                                                                                       |
| **Fastmail**             | ✅ Community-reported | Confirmed working in [#3](https://github.com/Daisytwo/n8n-nodes-caldav-pro/issues/3). Base URL `https://caldav.fastmail.com/dav` — no trailing slash. App password required; a read-only one works for reading, and read-only calendars show as 🔒. |
| Radicale                 | ✅ Community-reported | Connecting and creating events confirmed in [#2](https://github.com/Daisytwo/n8n-nodes-caldav-pro/issues/2).                                                        |
| NextCloud                | 🟡 Expected          | SabreDAV-based, same backend as Infomaniak. Base URL typically `https://<host>/remote.php/dav/`.                                                                    |
| iCloud                   | 🟡 Expected          | Requires app-specific password. Base URL `https://caldav.icloud.com/`.                                                                                             |
| Synology Calendar        | 🟡 Expected          | Base URL `https://<nas-host>:5006/caldav.php/`.                                                                                                                    |

### Verified run against Infomaniak Workspace (3.0.0)

`smoke-test.js`, run against a live account. Every object it creates is removed
afterwards.

```
[1] Create with an explicit timezone
    ✓ PUT accepted (201)
    ✓ event is readable
    ✓ start round-trips to the correct instant
    ✓ timezone reported
[2] Get Next and Search
    ✓ seeded event appears among upcoming
    ✓ keyword search finds exactly one
[3] Update preserves fields it was not given
    ✓ description / location / unmodelled CATEGORIES preserved
    ✓ SEQUENCE incremented
    ✓ stale If-Match is rejected with 412
[4] Locate an event whose filename is not its UID
    ✓ UID resolved to the real resource
[5] Recurring series expansion
    ✓ four occurrences, one week apart, distinct recurrenceIds
[6] Move between calendars
    – skipped, no second writable calendar on the test account

═══ ALL SMOKE TESTS PASSED ═══
```

Move is therefore covered only by the offline harness (`npm run smoke:dryrun`),
not against a live server.

## Known limitations / TODOs

1. **No OAuth2** — only HTTP Basic. Infomaniak / NextCloud / iCloud / Fastmail don't need it; if you're targeting Google Calendar use the official Google Calendar node instead.
2. **No Free/Busy** (`calendar-availability`) — only the basic `calendar-query` REPORT.
3. **No attachments** (VEVENT ATTACH property).
4. **No scheduling / RSVP** — attendees are written as ATTENDEE lines, but no server-side `METHOD:REQUEST` invitation email is triggered.
5. **A recurring series lives in one resource** — every occurrence shares one UID and one URL. Delete and Update therefore refuse to touch a recurring event unless you say which: set **Occurrence** to a `recurrenceId` for a single date, or **Entire Series** for all of them.
6. **No `VTIMEZONE` is written** — events are stored with a `TZID` parameter but without the matching `VTIMEZONE` component. Clients resolve IANA identifiers from their own database, so this works in practice, but it is not strictly RFC 5545 compliant.

## Built with AI

This node was designed, coded, and tested end-to-end with the help of **Anthropic Claude** via [Claude Code](https://claude.com/claude-code). The AI agent:

- Analysed the official n8n Google Calendar node as a structural reference.
- Designed the resource/operation layout, credential flow, and discovery cascade.
- Wrote every file — TypeScript sources, iCalendar builder/parser, XML parsing, UI descriptions, eslint config.
- Ran a live end-to-end test against a real Infomaniak Workspace account and iterated until all 7 protocol stages passed (auth → discovery → list → create → REPORT → delete → verify).
- Hardened the code: removed hard-coded secrets, sanitised logs, scrubbed personal data before publishing.

If you find a bug or want a feature, open an issue — I'll fix it the same way.

## Development

```bash
npm run dev           # tsc --watch
npm run build         # tsc + copy node icons into dist/
npm run lint          # eslint (flat config, eslint.config.mjs)
npm run lint:selftest # assert the n8n lint presets actually enforce
npm run check:package # assert the tarball has what it should and nothing more
npm run format        # prettier
npm test              # vitest — unit tests, no server needed
npm run test:watch    # vitest in watch mode
npm run smoke:dryrun  # smoke test against an in-memory server
```

CI runs all of these on push and on pull requests. The live smoke test is not
part of it — it needs credentials and writes to a real calendar.

Development requires Node 22: `n8n-workflow`, a dev dependency, pulls in
`isolated-vm`, which declares `engines >=22.0.0` and fails to install on Node
20. The published package is unaffected — it depends only on `fast-xml-parser`
and `ical.js`, and supports Node 20.15+.

The tests cover iCalendar generation, the update merge, recurrence expansion,
event lookup, and the read operations end to end against a fake CalDAV server —
no network and no credentials required.

They run the
same input under several host timezones (`UTC`, `Europe/Berlin`,
`America/New_York`, `Asia/Tokyo`) and assert the output is identical — the
timezone bugs fixed in 2.7.0 were only visible when the host's zone differed
from the event's, which is the normal case in Docker.

### Manual testing against your CalDAV server

`smoke-test.js` exercises a real server end to end: discovery, create, read,
update with `If-Match`, UID lookup, recurrence expansion, and move. It removes
everything it creates, and lists anything it could not remove.

Put your credentials in a `.env` next to it — see `.env.example`. That file is
gitignored and cannot reach the npm package, which ships only `dist/`. Use an
app password and revoke it when you are done.

```bash
CALDAV_TEST_CALENDARS=Test1,Test2 node smoke-test.js
```

`CALDAV_TEST_CALENDARS` picks which writable calendars to use. Set it: the
script creates, moves, and deletes events, so it should not run loose in a
calendar you actually use. Without it, the first two writable calendars are
taken — read-only ones are skipped automatically, since shared calendars and
subscribed feeds reject writes.

Run `npm run smoke:dryrun` first. It executes the same script against an
in-memory CalDAV server, so a scripting error surfaces before anything touches
a real calendar.

## License

MIT
