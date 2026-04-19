import {
	buildRRule,
	buildVAlarm,
	buildVCalendarForEvent,
	EventInput,
	parseVEvents,
	parseTriggerToMinutes,
} from '../nodes/CalDav/helpers/ICal';

describe('iCal – RRULE builder', () => {
	test('DAILY every 2 days, 10 occurrences', () => {
		const r = buildRRule({
			frequency: 'DAILY',
			interval: 2,
			endType: 'count',
			count: 10,
		});
		expect(r).toBe('FREQ=DAILY;INTERVAL=2;COUNT=10');
	});

	test('WEEKLY with BYDAY and UNTIL', () => {
		const r = buildRRule({
			frequency: 'WEEKLY',
			interval: 1,
			endType: 'until',
			until: new Date('2026-12-31T23:59:59Z'),
			byDay: 'MO,WE,FR',
		});
		expect(r).toMatch(/^FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261231T235959Z$/);
	});

	test('MONTHLY never-ending has no COUNT/UNTIL', () => {
		const r = buildRRule({ frequency: 'MONTHLY', interval: 1, endType: 'never' });
		expect(r).toBe('FREQ=MONTHLY');
	});

	test('BYDAY ordinals accepted', () => {
		const r = buildRRule({
			frequency: 'MONTHLY',
			interval: 1,
			endType: 'never',
			byDay: '2MO,-1FR',
		});
		expect(r).toBe('FREQ=MONTHLY;BYDAY=2MO,-1FR');
	});

	test('invalid BYDAY tokens silently dropped', () => {
		const r = buildRRule({
			frequency: 'WEEKLY',
			interval: 1,
			endType: 'never',
			byDay: 'MO, BOGUS ,FR',
		});
		expect(r).toBe('FREQ=WEEKLY;BYDAY=MO,FR');
	});
});

describe('iCal – VALARM builder', () => {
	test('Generates DISPLAY VALARM with TRIGGER -PTxxM', () => {
		const lines = buildVAlarm(15, 'My Event');
		expect(lines).toEqual([
			'BEGIN:VALARM',
			'ACTION:DISPLAY',
			'DESCRIPTION:My Event',
			'TRIGGER:-PT15M',
			'END:VALARM',
		]);
	});

	test('0 minutes => TRIGGER -PT0M', () => {
		const lines = buildVAlarm(0, 'x');
		expect(lines).toContain('TRIGGER:-PT0M');
	});

	test('escapes special chars in description', () => {
		const lines = buildVAlarm(5, 'Dinner; café, "VIP"');
		expect(lines).toContain('DESCRIPTION:Dinner\\; café\\, "VIP"');
	});
});

describe('iCal – VCALENDAR for event', () => {
	const sampleEvent = (): EventInput => ({
		uid: 'evt-1@n8n',
		title: 'Meeting',
		start: new Date('2026-04-14T10:00:00Z'),
		end: new Date('2026-04-14T11:00:00Z'),
		location: 'HQ',
		description: 'Quarterly sync',
		reminderMinutes: 15,
	});

	test('Contains VTIMEZONE before VEVENT (Europe/Berlin)', () => {
		const ical = buildVCalendarForEvent(sampleEvent(), 'Europe/Berlin');
		const tzIdx = ical.indexOf('BEGIN:VTIMEZONE');
		const evIdx = ical.indexOf('BEGIN:VEVENT');
		expect(tzIdx).toBeGreaterThan(0);
		expect(evIdx).toBeGreaterThan(tzIdx);
		// CRLF line endings
		expect(ical).toContain('\r\n');
	});

	test('DTSTART uses TZID, not UTC', () => {
		const ical = buildVCalendarForEvent(sampleEvent(), 'Europe/Berlin');
		expect(ical).toMatch(/DTSTART;TZID=Europe\/Berlin:20260414T120000/);
		expect(ical).toMatch(/DTEND;TZID=Europe\/Berlin:20260414T130000/);
	});

	test('All-day event uses VALUE=DATE and no VTIMEZONE', () => {
		const allDay: EventInput = {
			uid: 'all-1',
			title: 'Holiday',
			start: new Date(Date.UTC(2026, 3, 14)),
			end: new Date(Date.UTC(2026, 3, 14)),
			allDay: true,
		};
		const ical = buildVCalendarForEvent(allDay, 'Europe/Berlin');
		expect(ical).not.toContain('BEGIN:VTIMEZONE');
		expect(ical).toMatch(/DTSTART;VALUE=DATE:20260414/);
		expect(ical).toMatch(/DTEND;VALUE=DATE:20260415/);
	});

	test('Reminder generates VALARM block', () => {
		const ical = buildVCalendarForEvent(sampleEvent(), 'Europe/Berlin');
		expect(ical).toMatch(/BEGIN:VALARM[\s\S]+TRIGGER:-PT15M[\s\S]+END:VALARM/);
	});

	test('Recurring event includes RRULE', () => {
		const evt: EventInput = {
			...sampleEvent(),
			recurrence: {
				frequency: 'WEEKLY',
				interval: 1,
				endType: 'count',
				count: 4,
				byDay: 'MO,WE,FR',
			},
		};
		const ical = buildVCalendarForEvent(evt, 'Europe/Berlin');
		expect(ical).toMatch(/RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=4/);
	});

	test('UTC event skips VTIMEZONE', () => {
		const ical = buildVCalendarForEvent(sampleEvent(), 'UTC');
		expect(ical).not.toContain('BEGIN:VTIMEZONE');
	});
});

describe('iCal – parse trigger', () => {
	test('-PT15M -> 15', () => {
		expect(parseTriggerToMinutes('-PT15M')).toBe(15);
	});
	test('-PT1H30M -> 90', () => {
		expect(parseTriggerToMinutes('-PT1H30M')).toBe(90);
	});
	test('-P1D -> 1440', () => {
		expect(parseTriggerToMinutes('-P1D')).toBe(1440);
	});
	test('PT0S -> 0', () => {
		expect(parseTriggerToMinutes('PT0S')).toBe(0);
	});
	test('garbage -> null', () => {
		expect(parseTriggerToMinutes('nope')).toBeNull();
	});
});

describe('iCal – parse VEVENT', () => {
	test('round-trips a VEVENT with escaped characters', () => {
		const ical = [
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'BEGIN:VEVENT',
			'UID:abc-1',
			'SUMMARY:Dinner\\; café\\, "VIP"',
			'DESCRIPTION:Line1\\nLine2',
			'LOCATION:Berlin',
			'DTSTART;TZID=Europe/Berlin:20260414T120000',
			'DTEND;TZID=Europe/Berlin:20260414T130000',
			'END:VEVENT',
			'END:VCALENDAR',
		].join('\r\n');
		const events = parseVEvents(ical);
		expect(events).toHaveLength(1);
		expect(events[0].uid).toBe('abc-1');
		expect(events[0].summary).toBe('Dinner; café, "VIP"');
		expect(events[0].description).toBe('Line1\nLine2');
		expect(events[0].tzid).toBe('Europe/Berlin');
		expect(events[0].allDay).toBe(false);
	});

	test('DATE-valued DTSTART flagged as all-day', () => {
		const ical = [
			'BEGIN:VEVENT',
			'UID:ad-1',
			'SUMMARY:Holiday',
			'DTSTART;VALUE=DATE:20260414',
			'DTEND;VALUE=DATE:20260415',
			'END:VEVENT',
		].join('\r\n');
		const [e] = parseVEvents(ical);
		expect(e.allDay).toBe(true);
	});

	test('handles CRLF line folding', () => {
		const ical = [
			'BEGIN:VEVENT',
			'UID:fold-1',
			'SUMMARY:This is a very long title that exceeds seventy-five octets on a',
			' single line and must be folded onto a continuation line per RFC 5545',
			'DTSTART;TZID=UTC:20260101T000000',
			'END:VEVENT',
		].join('\r\n');
		const [e] = parseVEvents(ical);
		expect(e.uid).toBe('fold-1');
		expect(e.summary).toMatch(/single line and must be folded/);
	});
});
