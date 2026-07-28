import { describe, expect, it } from 'vitest';
import { expandCalendarObject, parseICalEvent } from '../nodes/CalDav/GenericFunctions';
import { HOST_ZONES, withTZ } from './helpers';

const URL = 'https://example.com/cal/series.ics';

function calendar(...body: string[]): string {
	return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//x//EN', ...body, 'END:VCALENDAR'].join(
		'\r\n',
	);
}

/** A Monday-weekly series that started long before any window we query. */
const weeklySince2020 = calendar(
	'BEGIN:VEVENT',
	'UID:series',
	'DTSTAMP:20200101T000000Z',
	'DTSTART:20200106T100000Z',
	'DTEND:20200106T110000Z',
	'SUMMARY:Weekly standup',
	'RRULE:FREQ=WEEKLY;BYDAY=MO',
	'END:VEVENT',
);

const APRIL = { start: new Date('2026-04-01T00:00:00Z'), end: new Date('2026-05-01T00:00:00Z') };

describe('expandCalendarObject — recurrence', () => {
	it('reports occurrences inside the window, not the original start date', () => {
		// The bug this replaces: a series begun in 2020 was reported once, dated
		// 2020, no matter which window was queried.
		const out = expandCalendarObject(weeklySince2020, URL, 'e1', APRIL.start, APRIL.end);
		expect(out.length).toBeGreaterThan(3);
		for (const ev of out) {
			expect(new Date(ev.start!).getTime()).toBeGreaterThanOrEqual(APRIL.start.getTime());
			expect(new Date(ev.start!).getTime()).toBeLessThan(APRIL.end.getTime());
		}
		expect(out.map((e) => e.start)).toContain('2026-04-06T10:00:00.000Z');
		expect(out.map((e) => e.start)).toContain('2026-04-27T10:00:00.000Z');
	});

	it('gives every occurrence the series UID and a distinguishing recurrenceId', () => {
		const out = expandCalendarObject(weeklySince2020, URL, 'e1', APRIL.start, APRIL.end);
		expect(new Set(out.map((e) => e.uid))).toEqual(new Set(['series']));
		expect(new Set(out.map((e) => e.recurrenceId)).size).toBe(out.length);
	});

	it('carries the series details onto each occurrence', () => {
		const out = expandCalendarObject(weeklySince2020, URL, 'e1', APRIL.start, APRIL.end);
		expect(out[0].summary).toBe('Weekly standup');
		expect(out[0].rrule).toContain('FREQ=WEEKLY');
		expect(out[0].url).toBe(URL);
		expect(out[0].etag).toBe('e1');
	});

	it('honours COUNT and stops at the end of the series', () => {
		const limited = calendar(
			'BEGIN:VEVENT',
			'UID:limited',
			'DTSTAMP:20260101T000000Z',
			'DTSTART:20260406T100000Z',
			'DTEND:20260406T110000Z',
			'SUMMARY:Three only',
			'RRULE:FREQ=WEEKLY;COUNT=3',
			'END:VEVENT',
		);
		const out = expandCalendarObject(limited, URL, undefined, APRIL.start, APRIL.end);
		expect(out).toHaveLength(3);
	});

	it('skips dates removed with EXDATE', () => {
		const withExdate = calendar(
			'BEGIN:VEVENT',
			'UID:series',
			'DTSTAMP:20260101T000000Z',
			'DTSTART:20260406T100000Z',
			'DTEND:20260406T110000Z',
			'SUMMARY:Weekly standup',
			'RRULE:FREQ=WEEKLY;BYDAY=MO',
			'EXDATE:20260420T100000Z',
			'END:VEVENT',
		);
		const starts = expandCalendarObject(withExdate, URL, undefined, APRIL.start, APRIL.end).map(
			(e) => e.start,
		);
		expect(starts).toContain('2026-04-13T10:00:00.000Z');
		expect(starts).not.toContain('2026-04-20T10:00:00.000Z');
	});

	it('applies a RECURRENCE-ID override in place of the generated occurrence', () => {
		const withOverride = calendar(
			'BEGIN:VEVENT',
			'UID:series',
			'DTSTAMP:20260101T000000Z',
			'DTSTART:20260406T100000Z',
			'DTEND:20260406T110000Z',
			'SUMMARY:Weekly standup',
			'RRULE:FREQ=WEEKLY;BYDAY=MO',
			'END:VEVENT',
			'BEGIN:VEVENT',
			'UID:series',
			'DTSTAMP:20260101T000000Z',
			'RECURRENCE-ID:20260413T100000Z',
			'DTSTART:20260413T140000Z',
			'DTEND:20260413T150000Z',
			'SUMMARY:Weekly standup (moved)',
			'END:VEVENT',
		);
		const out = expandCalendarObject(withOverride, URL, undefined, APRIL.start, APRIL.end);
		const moved = out.find((e) => e.start === '2026-04-13T14:00:00.000Z');
		expect(moved?.summary).toBe('Weekly standup (moved)');
		expect(out.map((e) => e.start)).not.toContain('2026-04-13T10:00:00.000Z');
	});

	it('includes an occurrence that straddles the start of the window', () => {
		const overnight = calendar(
			'BEGIN:VEVENT',
			'UID:night',
			'DTSTAMP:20260101T000000Z',
			'DTSTART:20260405T220000Z',
			'DTEND:20260406T060000Z',
			'SUMMARY:Night shift',
			'RRULE:FREQ=DAILY;COUNT=2',
			'END:VEVENT',
		);
		const out = expandCalendarObject(
			overnight,
			URL,
			undefined,
			new Date('2026-04-06T00:00:00Z'),
			new Date('2026-04-06T12:00:00Z'),
		);
		expect(out.map((e) => e.start)).toContain('2026-04-05T22:00:00.000Z');
	});

	it('expands all-day series as dates', () => {
		const allDay = calendar(
			'BEGIN:VEVENT',
			'UID:ad',
			'DTSTAMP:20260101T000000Z',
			'DTSTART;VALUE=DATE:20260406',
			'DTEND;VALUE=DATE:20260407',
			'SUMMARY:Daily allday',
			'RRULE:FREQ=DAILY;COUNT=3',
			'END:VEVENT',
		);
		const out = expandCalendarObject(allDay, URL, undefined, APRIL.start, APRIL.end);
		expect(out).toHaveLength(3);
		expect(out.map((e) => e.start)).toEqual(['2026-04-06', '2026-04-07', '2026-04-08']);
		expect(out.every((e) => e.allDay)).toBe(true);
	});

	it('bounds an open-ended series instead of running away', () => {
		const out = expandCalendarObject(
			calendar(
				'BEGIN:VEVENT',
				'UID:forever',
				'DTSTAMP:20260101T000000Z',
				'DTSTART:20260401T100000Z',
				'DTEND:20260401T110000Z',
				'SUMMARY:Hourly forever',
				'RRULE:FREQ=HOURLY',
				'END:VEVENT',
			),
			URL,
			undefined,
			APRIL.start,
			APRIL.end,
		);
		// One month of hourly occurrences is capped, not emitted in full.
		expect(out.length).toBeLessThanOrEqual(1000);
		expect(out.length).toBeGreaterThan(0);
	});
});

describe('expandCalendarObject — non-recurring and edge cases', () => {
	const single = calendar(
		'BEGIN:VEVENT',
		'UID:single',
		'DTSTAMP:20260101T000000Z',
		'DTSTART:20260420T120000Z',
		'DTEND:20260420T130000Z',
		'SUMMARY:One off',
		'END:VEVENT',
	);

	it('passes a plain event through once', () => {
		const out = expandCalendarObject(single, URL, undefined, APRIL.start, APRIL.end);
		expect(out).toHaveLength(1);
		expect(out[0].recurrenceId).toBeUndefined();
		expect(out[0].start).toBe('2026-04-20T12:00:00.000Z');
	});

	it('returns the master unexpanded when no window is given', () => {
		const out = expandCalendarObject(weeklySince2020, URL);
		expect(out).toHaveLength(1);
		expect(out[0].start).toBe('2020-01-06T10:00:00.000Z');
	});

	it('reports orphaned overrides as standalone events', () => {
		const orphan = calendar(
			'BEGIN:VEVENT',
			'UID:series',
			'DTSTAMP:20260101T000000Z',
			'RECURRENCE-ID:20260413T100000Z',
			'DTSTART:20260413T140000Z',
			'DTEND:20260413T150000Z',
			'SUMMARY:Only the exception',
			'END:VEVENT',
		);
		const out = expandCalendarObject(orphan, URL, undefined, APRIL.start, APRIL.end);
		expect(out).toHaveLength(1);
		expect(out[0].summary).toBe('Only the exception');
	});

	it('returns nothing for unparseable input rather than throwing', () => {
		expect(expandCalendarObject('not a calendar', URL)).toEqual([]);
		expect(expandCalendarObject(calendar(), URL)).toEqual([]);
	});
});

describe('time resolution', () => {
	const berlinNoVtimezone = calendar(
		'BEGIN:VEVENT',
		'UID:tz',
		'DTSTAMP:20260101T000000Z',
		'DTSTART;TZID=Europe/Berlin:20260420T140000',
		'DTEND;TZID=Europe/Berlin:20260420T150000',
		'SUMMARY:Berlin afternoon',
		'END:VEVENT',
	);

	it('resolves a TZID that has no VTIMEZONE, independently of the host', () => {
		// ical.js leaves such a time "floating"; reading it with the host's zone
		// would move the event. 14:00 Berlin in April is 12:00 UTC.
		for (const host of HOST_ZONES) {
			const out = withTZ(host, () => expandCalendarObject(berlinNoVtimezone, URL));
			expect(out[0].start).toBe('2026-04-20T12:00:00.000Z');
			expect(out[0].timezone).toBe('Europe/Berlin');
		}
	});

	it('agrees with a correct VTIMEZONE, which is now only a fallback', () => {
		const withVtimezone = calendar(
			'BEGIN:VTIMEZONE',
			'TZID:Europe/Berlin',
			'BEGIN:DAYLIGHT',
			'TZOFFSETFROM:+0100',
			'TZOFFSETTO:+0200',
			'TZNAME:CEST',
			'DTSTART:19700329T020000',
			'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
			'END:DAYLIGHT',
			'BEGIN:STANDARD',
			'TZOFFSETFROM:+0200',
			'TZOFFSETTO:+0100',
			'TZNAME:CET',
			'DTSTART:19701025T030000',
			'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
			'END:STANDARD',
			'END:VTIMEZONE',
			'BEGIN:VEVENT',
			'UID:tz',
			'DTSTAMP:20260101T000000Z',
			'DTSTART;TZID=Europe/Berlin:20260420T140000',
			'DTEND;TZID=Europe/Berlin:20260420T150000',
			'SUMMARY:Berlin afternoon',
			'END:VEVENT',
		);
		const out = withTZ('America/New_York', () => expandCalendarObject(withVtimezone, URL));
		expect(out[0].start).toBe('2026-04-20T12:00:00.000Z');
	});

	it('tracks the offset change across a DST boundary within one series', () => {
		// Berlin leaves CET on 2026-03-29. A 09:00 local series must stay 09:00
		// local, which means the UTC instant shifts by an hour across the change.
		const series = calendar(
			'BEGIN:VEVENT',
			'UID:dst',
			'DTSTAMP:20260101T000000Z',
			'DTSTART;TZID=Europe/Berlin:20260326T090000',
			'DTEND;TZID=Europe/Berlin:20260326T100000',
			'SUMMARY:Morning sync',
			'RRULE:FREQ=WEEKLY;BYDAY=TH;COUNT=3',
			'END:VEVENT',
		);
		const out = withTZ('UTC', () =>
			expandCalendarObject(
				series,
				URL,
				undefined,
				new Date('2026-03-01T00:00:00Z'),
				new Date('2026-05-01T00:00:00Z'),
			),
		);
		expect(out.map((e) => e.start)).toEqual([
			'2026-03-26T08:00:00.000Z', // CET  (UTC+1)
			'2026-04-02T07:00:00.000Z', // CEST (UTC+2)
			'2026-04-09T07:00:00.000Z',
		]);
	});

	it('emits sortable, unambiguous timestamps', () => {
		const out = expandCalendarObject(weeklySince2020, URL, undefined, APRIL.start, APRIL.end);
		const starts = out.map((e) => e.start!);
		expect([...starts].sort()).toEqual(starts);
		for (const s of starts) expect(Number.isNaN(new Date(s).getTime())).toBe(false);
	});
});

describe('parseICalEvent', () => {
	it('prefers the series master over an override serialised first', () => {
		const overrideFirst = calendar(
			'BEGIN:VEVENT',
			'UID:series',
			'DTSTAMP:20260101T000000Z',
			'RECURRENCE-ID:20260413T100000Z',
			'DTSTART:20260413T140000Z',
			'DTEND:20260413T150000Z',
			'SUMMARY:The override',
			'END:VEVENT',
			'BEGIN:VEVENT',
			'UID:series',
			'DTSTAMP:20260101T000000Z',
			'DTSTART:20260406T100000Z',
			'DTEND:20260406T110000Z',
			'SUMMARY:The master',
			'RRULE:FREQ=WEEKLY;BYDAY=MO',
			'END:VEVENT',
		);
		expect(parseICalEvent(overrideFirst, URL)?.summary).toBe('The master');
	});
});

describe('broken VTIMEZONE from a real provider', () => {
	// Taken verbatim from an event written by Infomaniak's own importer: the
	// TZID says Europe/Berlin, but the transition rules are the US ones, and
	// each RRULE contradicts its own DTSTART. No observance matches a July
	// date, so ical.js resolves the offset to zero and every summer event
	// lands two hours late.
	const infomaniakImport = calendar(
		'BEGIN:VTIMEZONE',
		'TZID:Europe/Berlin',
		'BEGIN:STANDARD',
		'DTSTART:20261025T010000',
		'TZOFFSETTO:+0100',
		'TZOFFSETFROM:+0200',
		'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
		'END:STANDARD',
		'BEGIN:DAYLIGHT',
		'DTSTART:20260329T010000',
		'TZOFFSETTO:+0200',
		'TZOFFSETFROM:+0100',
		'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
		'END:DAYLIGHT',
		'END:VTIMEZONE',
		'BEGIN:VEVENT',
		'UID:pickup',
		'DTSTAMP:20260101T000000Z',
		'DTSTART;TZID=Europe/Berlin:20260728T210000',
		'DTEND;TZID=Europe/Berlin:20260728T213000',
		'SUMMARY:Penny pickup',
		'END:VEVENT',
	);

	it('uses the IANA definition rather than the broken one', () => {
		for (const host of HOST_ZONES) {
			const [event] = withTZ(host, () => expandCalendarObject(infomaniakImport, URL));
			// 21:00 in Berlin on 28 July is CEST, so 19:00Z — not the 21:00Z the
			// embedded VTIMEZONE would produce.
			expect(event.start).toBe('2026-07-28T19:00:00.000Z');
			expect(event.end).toBe('2026-07-28T19:30:00.000Z');
		}
	});

	it('still reports the timezone it was stored under', () => {
		const [event] = expandCalendarObject(infomaniakImport, URL);
		expect(event.timezone).toBe('Europe/Berlin');
	});

	it('reads back as the intended local time', () => {
		const [event] = expandCalendarObject(infomaniakImport, URL);
		const berlin = new Intl.DateTimeFormat('en-GB', {
			timeZone: 'Europe/Berlin',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		});
		expect(berlin.format(new Date(event.start!))).toBe('21:00');
	});
});
