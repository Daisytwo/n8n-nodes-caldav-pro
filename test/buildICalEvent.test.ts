import { describe, expect, it } from 'vitest';
import { buildICalEvent } from '../nodes/CalDav/GenericFunctions';
import { HOST_ZONES, line, unfold, withTZ } from './helpers';

const base = {
	uid: 'test-uid',
	summary: 'Team meeting',
	start: '2026-04-20T14:00:00+02:00',
	end: '2026-04-20T15:00:00+02:00',
};

describe('buildICalEvent — timezone handling', () => {
	it('emits the wall clock of the requested TZID, not the host timezone', () => {
		// 14:00+02:00 is 14:00 in Berlin by definition. The host's own timezone
		// must not enter into it. Before the fix this produced 20260420T120000
		// on a UTC host, shifting every event by the host's offset.
		const ics = withTZ('UTC', () => buildICalEvent({ ...base, timezone: 'Europe/Berlin' }));
		expect(line(ics, 'DTSTART')).toBe('DTSTART;TZID=Europe/Berlin:20260420T140000');
		expect(line(ics, 'DTEND')).toBe('DTEND;TZID=Europe/Berlin:20260420T150000');
	});

	it('produces identical output on every host timezone', () => {
		const outputs = HOST_ZONES.map((tz) =>
			withTZ(tz, () => buildICalEvent({ ...base, timezone: 'Europe/Berlin' })),
		).map((ics) => line(ics, 'DTSTART'));
		expect(new Set(outputs).size).toBe(1);
	});

	it('converts across zones rather than relabelling the clock', () => {
		// The same instant expressed in Tokyo is the next calendar day.
		const ics = withTZ('UTC', () => buildICalEvent({ ...base, timezone: 'Asia/Tokyo' }));
		expect(line(ics, 'DTSTART')).toBe('DTSTART;TZID=Asia/Tokyo:20260420T210000');
	});

	it('falls back to UTC with a Z suffix when no timezone is given', () => {
		const ics = withTZ('Asia/Tokyo', () => buildICalEvent(base));
		expect(line(ics, 'DTSTART')).toBe('DTSTART:20260420T120000Z');
	});

	it('rejects an unknown timezone with an actionable message', () => {
		expect(() => buildICalEvent({ ...base, timezone: 'Europe/Bearlin' })).toThrow(
			/Unknown timezone "Europe\/Bearlin".*IANA/s,
		);
	});

	it('rejects an unparseable date naming the offending field', () => {
		expect(() => buildICalEvent({ ...base, start: 'tomorrow-ish' })).toThrow(
			/Invalid ISO 8601 date in "Start"/,
		);
	});
});

describe('buildICalEvent — all-day events', () => {
	it('keeps the calendar date the user wrote', () => {
		// 2026-04-20T00:00+02:00 is 2026-04-19T22:00Z. Reading UTC components,
		// as the old code did, moved the event to the 19th.
		const ics = withTZ('UTC', () =>
			buildICalEvent({
				...base,
				start: '2026-04-20T00:00:00+02:00',
				end: '2026-04-20T23:59:59+02:00',
				allDay: true,
			}),
		);
		expect(line(ics, 'DTSTART')).toBe('DTSTART;VALUE=DATE:20260420');
	});

	it('is stable across host timezones', () => {
		const outputs = HOST_ZONES.map((tz) =>
			withTZ(tz, () =>
				buildICalEvent({
					...base,
					start: '2026-04-20T00:00:00+02:00',
					end: '2026-04-20T23:59:59+02:00',
					allDay: true,
				}),
			),
		).map((ics) => line(ics, 'DTSTART'));
		expect(new Set(outputs).size).toBe(1);
	});

	it('makes a same-day range a one-day event via exclusive DTEND', () => {
		const ics = buildICalEvent({
			...base,
			start: '2026-04-20T00:00:00Z',
			end: '2026-04-20T00:00:00Z',
			allDay: true,
		});
		expect(line(ics, 'DTSTART')).toBe('DTSTART;VALUE=DATE:20260420');
		expect(line(ics, 'DTEND')).toBe('DTEND;VALUE=DATE:20260421');
	});

	it('treats an inclusive end-of-day the same way', () => {
		const ics = buildICalEvent({
			...base,
			start: '2026-04-20T00:00:00Z',
			end: '2026-04-20T23:59:59Z',
			allDay: true,
		});
		expect(line(ics, 'DTEND')).toBe('DTEND;VALUE=DATE:20260421');
	});

	it('leaves an already-exclusive multi-day range untouched', () => {
		const ics = buildICalEvent({
			...base,
			start: '2026-04-20T00:00:00Z',
			end: '2026-04-23T00:00:00Z',
			allDay: true,
		});
		expect(line(ics, 'DTEND')).toBe('DTEND;VALUE=DATE:20260423');
	});

	it('never attaches a TZID to a DATE value', () => {
		const ics = buildICalEvent({
			...base,
			start: '2026-04-20T00:00:00Z',
			end: '2026-04-21T00:00:00Z',
			allDay: true,
			timezone: 'Europe/Berlin',
		});
		expect(line(ics, 'DTSTART')).not.toMatch(/TZID/);
	});
});

describe('buildICalEvent — serialisation', () => {
	it('uses CRLF line endings and a trailing newline', () => {
		const ics = buildICalEvent(base);
		expect(ics.endsWith('\r\n')).toBe(true);
		expect(ics.split('\r\n').length).toBeGreaterThan(5);
		expect(ics.replace(/\r\n/g, '')).not.toMatch(/\n/);
	});

	it('folds long lines', () => {
		const ics = buildICalEvent({ ...base, description: 'x'.repeat(300) });
		// RFC 5545 recommends 75 octets. ical.js applies its fold length to the
		// content only, so continuation lines come out one octet longer once the
		// leading space is counted. Accepting 76 keeps us from having to mutate
		// ical.js's global foldLength, which is shared with every other node in
		// the n8n process.
		for (const physical of ics.split('\r\n')) {
			expect(Buffer.byteLength(physical, 'utf8')).toBeLessThanOrEqual(76);
		}
		expect(ics.split('\r\n').some((l) => l.startsWith(' '))).toBe(true);
		// …and the folding is reversible.
		expect(line(ics, 'DESCRIPTION')).toBe(`DESCRIPTION:${'x'.repeat(300)}`);
	});

	it('escapes commas, semicolons, and newlines in text values', () => {
		const ics = buildICalEvent({ ...base, description: 'a,b;c\nd' });
		expect(line(ics, 'DESCRIPTION')).toBe('DESCRIPTION:a\\,b\\;c\\nd');
	});

	it('writes attendees with RSVP and an escaped display name', () => {
		const ics = buildICalEvent({
			...base,
			attendees: [{ email: 'alice@example.com', name: 'Müller, Anna' }],
		});
		const attendee = line(ics, 'ATTENDEE')!;
		expect(attendee).toContain('mailto:alice@example.com');
		expect(attendee).toContain('RSVP=TRUE');
		// A comma inside a parameter value requires quoting, not backslashes.
		expect(attendee).toContain('CN="Müller, Anna"');
	});

	it('writes one VALARM per reminder with a negative trigger', () => {
		const ics = buildICalEvent({
			...base,
			reminders: [{ minutesBefore: 15 }, { minutesBefore: 1440, action: 'EMAIL' }],
		});
		const flat = unfold(ics);
		expect(flat.filter((l) => l === 'BEGIN:VALARM')).toHaveLength(2);
		expect(flat).toContain('TRIGGER:-PT15M');
		expect(flat).toContain('TRIGGER:-P1D');
		expect(flat).toContain('ACTION:EMAIL');
	});

	it('accepts an RRULE with or without the redundant prefix', () => {
		const withPrefix = buildICalEvent({ ...base, rrule: 'RRULE:FREQ=WEEKLY;BYDAY=MO' });
		const without = buildICalEvent({ ...base, rrule: 'FREQ=WEEKLY;BYDAY=MO' });
		expect(line(withPrefix, 'RRULE')).toBe('RRULE:FREQ=WEEKLY;BYDAY=MO');
		expect(line(without, 'RRULE')).toBe('RRULE:FREQ=WEEKLY;BYDAY=MO');
	});

	it('omits optional properties that were not supplied', () => {
		const ics = buildICalEvent(base);
		expect(line(ics, 'DESCRIPTION')).toBeUndefined();
		expect(line(ics, 'LOCATION')).toBeUndefined();
		expect(line(ics, 'RRULE')).toBeUndefined();
	});
});
