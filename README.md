# n8n-nodes-caldav-pro

A community node for [n8n](https://n8n.io) that connects your workflows to any **CalDAV calendar** — Infomaniak, NextCloud, iCloud, Fastmail, Synology, SOGo, Radicale, and any other RFC 4791-compliant server.

Drop it into a workflow to read, create, update, or delete calendar events — or let an **AI Agent** use it as a tool and manage your calendar from a chat prompt.

## What this node does

This node gives n8n a full CRUD interface to CalDAV calendars. In practical terms:

- **List your calendars** — auto-discovers every calendar on the server via CalDAV's well-known endpoints. No hard-coded URLs.
- **Create events** with title, start/end (ISO 8601 with timezone), description, location, attendees, recurrence (RRULE), and multiple reminders (VALARM).
- **Fetch events** for any time window via server-side `REPORT` queries — fast even on calendars with thousands of events.
- **Expand recurring series** — a weekly meeting is returned as the individual occurrences that fall inside your window, with `EXDATE` exclusions and moved instances (`RECURRENCE-ID`) applied.
- **Update events** — change time, location, reminders, attendees. Updates are applied as a patch: fields you don't supply keep their stored value, including properties this node doesn't model (categories, organiser, custom `X-` properties).
- **Delete events** by UID or URL.
- **Address events written by other clients** — Get / Update / Delete / Move accept either the event's URL (as returned by every read operation) or its UID, which is resolved against the server. Events created in Thunderbird, Apple Calendar, or a web UI are stored under a filename the server chose, not under their UID.
- **Round-trip iCalendar** — events you write come back correctly parsed, including RRULE, TZID, and alarms.
- **Use it as an AI Agent tool** — every field has an LLM-readable description with examples, so an agent can call it cold and get it right on the first try.

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
| `start` / `end`        | All-day: `2026-04-20`. Timed: an ISO 8601 UTC instant, `2026-04-20T12:00:00.000Z`.           |
| `timezone`             | The `TZID` the event is stored under, when it has one (e.g. `Europe/Berlin`).                |
| `allDay`               | `true` for date-only events.                                                                 |
| `recurrenceId`         | Present only on an occurrence of a recurring series, identifying which slot it is.           |
| `uid` / `url`          | Shared by every occurrence of a series.                                                      |
| `rrule`                | The series rule, repeated on each occurrence.                                                |
| `raw`                  | The full `VCALENDAR` source — only when **Simplify** is turned off.                          |

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

## AI Agent Usage

The node is declared `usableAsTool: true` with LLM-friendly descriptions on every parameter. An AI Agent can call it directly from a chat prompt. Example:

> *"Create a calendar event in my primary calendar for tomorrow at 14:00 Berlin
> time. Title: 'Kickoff with customer'. Duration: 1 hour. Location: 'Zoom — link
> in the invite'. Invite alice@example.com and bob@example.com. Remind me 1 day
> and 15 minutes before."*

The agent will populate:

- `resource` = `event`, `operation` = `create`
- `calendar` = picked from the dropdown via `getCalendars`
- `summary` = `"Kickoff with customer"`
- `start` = `"2026-04-22T14:00:00+02:00"`, `end` = `"2026-04-22T15:00:00+02:00"`
- `additionalFields.timezone` = `"Europe/Berlin"`
- `additionalFields.location` = `"Zoom — link in the invite"`
- `additionalFields.attendees` = two attendee objects
- `additionalFields.reminders` = `[{minutesBefore: 1440}, {minutesBefore: 15}]`

### Recommended system prompt

```
You are a calendar assistant with access to a CalDAV tool.

- Convert any time/date mentioned by the user to ISO 8601 with
  the Europe/Berlin timezone offset before calling the tool.
  Current time: {{ $now.toISO() }}.
- Always include "timezone": "Europe/Berlin" in additionalFields.
- Before creating: confirm title, start, end in one short sentence.
- Before deleting: always confirm with the event UID.
- If the user is vague ("irgendwann"), ask one clarifying question.
- Use the default calendar (first one returned by getCalendars)
  unless the user names a specific one.
```

## Tested with

| Provider                 | Status      | Notes                                                                                           |
| ------------------------ | ----------- | ----------------------------------------------------------------------------------------------- |
| **Infomaniak Workspace** | ✅ Verified | End-to-end test passed against a real Infomaniak Workspace account (SabreDAV backend).          |
| NextCloud                | 🟡 Expected | SabreDAV-based, same backend as Infomaniak. Base URL typically `https://<host>/remote.php/dav/`. |
| iCloud                   | 🟡 Expected | Requires app-specific password. Base URL `https://caldav.icloud.com/`.                          |
| Fastmail                 | 🟡 Expected | App password required. Base URL `https://caldav.fastmail.com/dav/`.                             |
| Synology Calendar        | 🟡 Expected | Base URL `https://<nas-host>:5006/caldav.php/`.                                                 |

### Verified E2E run (Infomaniak Workspace)

```
═══ CalDAV E2E Test against Infomaniak ═══
  Server: https://sync.infomaniak.com/
  User:   <redacted>

[1] Authenticating (PROPFIND /)              → 207 ✓
[2] Discover calendar-home-set               → /calendars/<user>/
[3] Calendar > Get All                       → 5 calendars
[4] Event > Create "CalDAV Pro E2E Test"     → PUT 201, ETag set
[5] Event > Get All for today                → event present
[6] Event > Delete                           → 204 ✓
[7] Event > Get All again                    → event gone ✓

═══ ALL TESTS PASSED ═══
```

## Known limitations / TODOs

1. **No OAuth2** — only HTTP Basic. Infomaniak / NextCloud / iCloud / Fastmail don't need it; if you're targeting Google Calendar use the official Google Calendar node instead.
2. **No Free/Busy** (`calendar-availability`) — only the basic `calendar-query` REPORT.
3. **No attachments** (VEVENT ATTACH property).
4. **No scheduling / RSVP** — attendees are written as ATTENDEE lines, but no server-side `METHOD:REQUEST` invitation email is triggered.
5. **Recurrence is per-series, not per-occurrence** — reads expand a series into its occurrences, but all occurrences share one UID and one URL. Deleting or updating by UID therefore affects the whole series; there is no way to change a single occurrence.
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
npm run dev        # tsc --watch
npm run build      # tsc + gulp build:icons
npm run lint       # eslint
npm run format     # prettier
npm test           # vitest — unit tests, no server needed
npm run test:watch # vitest in watch mode
```

The tests cover iCalendar generation, the update merge, recurrence expansion,
event lookup, and the read operations end to end against a fake CalDAV server —
no network and no credentials required.

They run the
same input under several host timezones (`UTC`, `Europe/Berlin`,
`America/New_York`, `Asia/Tokyo`) and assert the output is identical — the
timezone bugs fixed in 2.7.0 were only visible when the host's zone differed
from the event's, which is the normal case in Docker.

### Manual testing against your CalDAV server

Local test scripts (`e2e-test.js`, `smoke-test.js`) live in `.gitignore` so they
never end up in the published repo or npm package. To verify the build against
a real server during development, install the node into your local n8n custom
folder via `npm link` (see "Local development" above) and trigger the operations
through the n8n UI — that's the canonical integration path.

If you want a headless smoke check, write a small script that imports from
`dist/nodes/CalDav/GenericFunctions.js` and calls `discoverCalendars`,
`buildICalEvent`, `parseCalendarQueryResponse` directly. Read credentials
from environment variables — never hard-code them.

## License

MIT
