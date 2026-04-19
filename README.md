# n8n-nodes-caldav-pro

[![npm](https://img.shields.io/badge/n8n-community%20node-FF6D5A.svg)](https://www.npmjs.com/) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Two n8n community nodes for working with any CalDAV calendar server:

- **CalDAV** – standard node for workflows (triggers, schedulers, HTTP, etc.).
- **CalDAV Tool** – AI-Agent tool variant with `$fromAI()` support, tolerant
  parameter casing, and error-as-JSON default behaviour.

Tested against Infomaniak kMeet/Calendar, Nextcloud, Apple iCloud, Radicale,
Baikal, SOGo and generic RFC 4791 servers.

---

## Features

| Operation        | Standard | AI Tool | Notes |
|------------------|:--------:|:-------:|-------|
| Get Events       | ✅ | ✅ | Single date or date range. Recurring events are expanded. Empty result = empty array (never an error). |
| Create Event     | ✅ | ✅ | VTIMEZONE, VALARM, RRULE. |
| Update Event     | ✅ | ✅ | Partial update by UID (If-Match / ETag). |
| Delete Event     | ✅ | ✅ | By UID. 404 = `deleted:false` (no throw). |
| Get Free/Busy    | ✅ | ✅ | Free-busy REPORT with automatic fallback to calendar-query. |

Additional guarantees:

- **Timezones:** pulled from `this.getTimezone()`. VTIMEZONE is generated
  dynamically with proper DAYLIGHT + STANDARD components and correct DST
  rules for Europe, North America, Australia, New Zealand, Chile.
  `DTSTART;TZID=Europe/Berlin:20260414T120000` – never UTC literals for
  timed events.
- **RFC 5545 compliance:** CRLF line endings, line folding at 75 octets,
  escape sequences in TEXT properties, UTC DTSTAMP/CREATED/LAST-MODIFIED.
- **Security:** UID sanitization (`/[^\w\-.@]/g → '_'`), path-traversal
  guard, XML-safe response parsing, no credential or body logging.
- **AI-friendly:** every enum is a free-form string with allowed values in
  the description, and parameters accept camelCase, snake_case, UPPER_CASE
  and kebab-case interchangeably.

---

## Installation

### From the n8n UI (self-hosted)

`Settings → Community Nodes → Install` and enter:

```
n8n-nodes-caldav-pro
```

### From npm (CLI install)

```bash
npm install n8n-nodes-caldav-pro
```

In Docker:

```bash
docker exec -u 0 -it n8n \
  npm install -g n8n-nodes-caldav-pro
```

The two nodes show up in the palette as **CalDAV** and **CalDAV Tool**.

---

## Credentials setup

The same credential type (`CalDAV API`) is used by both nodes.

| Field        | Value |
|--------------|-------|
| Server URL   | Full CalDAV collection URL (must end with `/`) |
| Username     | Your account username |
| Password     | Account or app-specific password |

The connection test runs a `PROPFIND` against the collection URL.

### Infomaniak example

1. Log into [Infomaniak mail.infomaniak.com](https://mail.infomaniak.com) and
   open **Calendar → ⚙ Settings → Synchronize → CalDAV**.
2. Copy the CalDAV URL. It looks like:

   ```
   https://caldav.infomaniak.com/calendar/<user-id>/<calendar-id>/
   ```

3. Under **Security settings → Application passwords**, create an
   app password for n8n.
4. In n8n create a new `CalDAV API` credential with:
   - **Server URL:** paste the CalDAV URL above (keep the trailing `/`).
   - **Username:** your Infomaniak login (email).
   - **Password:** the app password.

### Nextcloud

```
https://cloud.example.com/remote.php/dav/calendars/<user>/<calendar-id>/
```

Use an app-token rather than your main password (Settings → Security →
Devices & sessions).

### Apple iCloud

```
https://caldav.icloud.com/<principal-id>/calendars/<calendar-id>/
```

Requires an **app-specific password**.

### Radicale / Baikal / SOGo

Use the calendar collection URL that the server admin gave you.
Radicale default layout: `https://host/<user>/<calendar>/`.

---

## AI Agent setup (CalDAV Tool)

Drop the **CalDAV Tool** node into an **AI Agent** subtree. Nothing else is
required – every field can be supplied by the model via `$fromAI()`.

### Suggested system prompt

```
You are a scheduling assistant. You can use the "caldav" tool to read,
create, update and delete events on the user's calendar, and to check
free/busy for specific time windows.

Rules:
- All datetimes MUST be ISO-8601 with a timezone offset, e.g.
  "2026-04-14T12:00:00+02:00". Never emit "Z" for local events.
- Before creating an event, call getFreeBusy for the requested window.
  If the window is busy, propose the next free slot instead.
- For recurring events: set Recurring_Event to true and fill in
  Recurrence_Frequency (DAILY/WEEKLY/MONTHLY/YEARLY), Recurrence_Interval,
  Recurrence_End_Type (count/until/never), Recurrence_Count or
  Recurrence_Until, and Recurrence_By_Day when relevant
  (e.g. "MO,WE,FR").
- If the tool returns {success:false, error:...}, tell the user what went
  wrong and ask for a correction; do not retry identical input.
- Today's date: {{$today}}. User timezone: {{$now.zoneName}}.
```

### End-to-end example: "Schedule a meeting with Jane next Tuesday 3pm"

1. Agent calls `caldav` with:
   ```json
   {
     "operation": "getFreeBusy",
     "Start_Date": "2026-04-21T15:00:00+02:00",
     "End_Date":   "2026-04-21T16:00:00+02:00"
   }
   ```
   Response: `{ success: true, isBusy: false, free: [...], busy: [] }`.

2. Agent calls `caldav` with:
   ```json
   {
     "operation": "createEvent",
     "Event_Title": "Meeting with Jane",
     "Start_Date_and_Time": "2026-04-21T15:00:00+02:00",
     "End_Date_and_Time":   "2026-04-21T16:00:00+02:00",
     "Location": "Office",
     "Reminder": 15
   }
   ```
   Response:
   ```json
   {
     "success": true,
     "operation": "createEvent",
     "uid": "c4b1c9de-...@n8n-caldav",
     "etag": "\"f00\"",
     "timezone": "Europe/Berlin",
     "event": { ... }
   }
   ```

---

## Operations

### Get Events

Inputs (all optional; at least one date must be resolvable):

| Field        | Type   | Description |
|--------------|--------|-------------|
| Date         | string | Single day as `YYYY-MM-DD`. |
| Start Date   | string | Range start (ISO-8601). |
| End Date     | string | Range end (ISO-8601). |

Output (never throws on empty):

```json
{
  "success": true,
  "operation": "getEvents",
  "rangeStart": "2026-04-14T00:00:00.000Z",
  "rangeEnd":   "2026-04-15T00:00:00.000Z",
  "count": 2,
  "events": [
    {
      "uid": "...",
      "summary": "Standup",
      "start": "2026-04-14T07:00:00.000Z",
      "end":   "2026-04-14T07:15:00.000Z",
      "allDay": false,
      "recurring": true,
      "rrule": "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"
    }
  ]
}
```

### Create Event

| Field                 | Type    | Notes |
|-----------------------|---------|-------|
| UID (optional)        | string  | Empty → UUID generated. |
| Event_Title           | string  | **required**. |
| Start_Date_and_Time   | string  | **required** – ISO-8601 with offset. |
| End_Date_and_Time     | string  | Default start + 1h. |
| Location              | string  |       |
| Description           | string  |       |
| All_Day_Event         | boolean | If true, emits `DTSTART;VALUE=DATE:YYYYMMDD`. |
| Reminder              | number  | Minutes before start. 0 → no VALARM. |
| Recurring_Event       | boolean | Enables RRULE. |
| Recurrence_Frequency  | string  | `DAILY` / `WEEKLY` / `MONTHLY` / `YEARLY`. |
| Recurrence_Interval   | number  | Default `1`. |
| Recurrence_End_Type   | string  | `count` / `until` / `never`. |
| Recurrence_Count      | number  | When `end_type=count`. |
| Recurrence_Until      | string  | When `end_type=until`. |
| Recurrence_By_Day     | string  | Comma-separated BYDAY tokens: `MO,TU,WE,TH,FR,SA,SU` (ordinals allowed: `2MO`, `-1FR`). |

### Update Event

All fields optional except **UID**. Omitted fields keep their existing
values. Uses `If-Match` with the current ETag.

### Delete Event

| Field | Type   |
|-------|--------|
| UID   | string (required) |

HTTP 404 → `deleted:false` (no error thrown).

### Get Free/Busy

| Field        | Type   |
|--------------|--------|
| Start_Date   | string (required) |
| End_Date     | string (required) |

Output:

```json
{
  "success": true,
  "operation": "getFreeBusy",
  "method": "freebusy-query",
  "rangeStart": "2026-04-14T08:00:00.000Z",
  "rangeEnd":   "2026-04-14T18:00:00.000Z",
  "busy": [ { "start": "...", "end": "..." } ],
  "free": [ { "start": "...", "end": "..." } ],
  "isBusy": true
}
```

---

## Error handling

Both nodes return structured JSON on failure (and on success):

```json
{
  "success": false,
  "error": "CalDAV PUT failed: HTTP 412 Precondition Failed",
  "operation": "updateEvent",
  "timestamp": "2026-04-19T10:12:34.567Z"
}
```

- **CalDAV Tool** defaults to `returnError` (the Agent never aborts on a
  tool error). Switch to `throwError` to propagate the error.
- **CalDAV** throws by default. Enable "Continue On Fail" in the node
  settings to get the JSON error payload instead.

---

## Development

```bash
npm install
npm run build        # tsc + gulp (icons)
npm run lint         # eslint
npm test             # jest (all suites)
npm run pack         # builds + emits n8n-nodes-caldav-pro-1.0.0.tgz
```

---

## License

MIT – see [LICENSE](LICENSE).
