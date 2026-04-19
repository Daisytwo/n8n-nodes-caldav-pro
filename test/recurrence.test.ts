import { parseRRule, expandEvent, parseICalDate } from '../nodes/CalDav/helpers/Recurrence';
import { ParsedEvent } from '../nodes/CalDav/helpers/ICal';

describe('Recurrence – RRULE parsing', () => {
	test('Daily with COUNT', () => {
		const r = parseRRule('FREQ=DAILY;COUNT=5');
		expect(r).toMatchObject({ freq: 'DAILY', interval: 1, count: 5 });
	});

	test('Weekly with INTERVAL and BYDAY', () => {
		const r = parseRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR');
		expect(r).toMatchObject({ freq: 'WEEKLY', interval: 2, byDay: ['MO', 'WE', 'FR'] });
	});

	test('UNTIL parsed as Date', () => {
		const r = parseRRule('FREQ=MONTHLY;UNTIL=20261231T235959Z');
		expect(r?.until?.toISOString()).toBe('2026-12-31T23:59:59.000Z');
	});

	test('Invalid FREQ -> null', () => {
		expect(parseRRule('FREQ=BOGUS')).toBeNull();
	});
});

describe('Recurrence – iCal date parsing', () => {
	test('DATE value returns allDay=true', () => {
		const { date, allDay } = parseICalDate('20260414');
		expect(allDay).toBe(true);
		expect(date.getUTCFullYear()).toBe(2026);
	});

	test('UTC DATE-TIME parsed verbatim', () => {
		const { date } = parseICalDate('20260414T120000Z');
		expect(date.toISOString()).toBe('2026-04-14T12:00:00.000Z');
	});

	test('Local DATE-TIME anchored via tzid', () => {
		const { date } = parseICalDate('20260414T120000', 'Europe/Berlin');
		// 12:00 Berlin time on 2026-04-14 is 10:00Z (DST in effect)
		expect(date.toISOString()).toBe('2026-04-14T10:00:00.000Z');
	});
});

function parsedEvent(overrides: Partial<ParsedEvent>): ParsedEvent {
	return {
		uid: 'e1',
		summary: 'Sample',
		allDay: false,
		raw: '',
		...overrides,
	};
}

describe('Recurrence – expansion within a window', () => {
	test('single non-recurring event inside window', () => {
		const event = parsedEvent({
			start: '20260414T120000Z',
			end: '20260414T130000Z',
		});
		const occ = expandEvent(
			event,
			new Date('2026-04-14T00:00:00Z'),
			new Date('2026-04-15T00:00:00Z'),
		);
		expect(occ).toHaveLength(1);
		expect(occ[0].start.toISOString()).toBe('2026-04-14T12:00:00.000Z');
	});

	test('non-recurring event outside window is filtered', () => {
		const event = parsedEvent({
			start: '20260414T120000Z',
			end: '20260414T130000Z',
		});
		const occ = expandEvent(
			event,
			new Date('2026-05-01T00:00:00Z'),
			new Date('2026-05-02T00:00:00Z'),
		);
		expect(occ).toHaveLength(0);
	});

	test('DAILY FREQ, COUNT=3 produces 3 occurrences', () => {
		const event = parsedEvent({
			start: '20260414T120000Z',
			end: '20260414T130000Z',
			rrule: 'FREQ=DAILY;COUNT=3',
		});
		const occ = expandEvent(
			event,
			new Date('2026-04-14T00:00:00Z'),
			new Date('2026-04-30T00:00:00Z'),
		);
		expect(occ).toHaveLength(3);
		expect(occ[0].start.toISOString()).toBe('2026-04-14T12:00:00.000Z');
		expect(occ[1].start.toISOString()).toBe('2026-04-15T12:00:00.000Z');
		expect(occ[2].start.toISOString()).toBe('2026-04-16T12:00:00.000Z');
	});

	test('WEEKLY BYDAY=MO,WE,FR expands 3 per week', () => {
		// 2026-04-13 is Monday
		const event = parsedEvent({
			start: '20260413T090000Z',
			end: '20260413T100000Z',
			rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6',
		});
		const occ = expandEvent(
			event,
			new Date('2026-04-01T00:00:00Z'),
			new Date('2026-05-01T00:00:00Z'),
		);
		const dows = occ.map((o) => o.start.getUTCDay()).sort();
		// Mon=1, Wed=3, Fri=5
		expect(new Set(dows)).toEqual(new Set([1, 3, 5]));
		expect(occ.length).toBeGreaterThan(0);
	});

	test('UNTIL caps the expansion', () => {
		const event = parsedEvent({
			start: '20260401T090000Z',
			end: '20260401T100000Z',
			rrule: 'FREQ=DAILY;UNTIL=20260403T235959Z',
		});
		const occ = expandEvent(
			event,
			new Date('2026-04-01T00:00:00Z'),
			new Date('2026-05-01T00:00:00Z'),
		);
		expect(occ).toHaveLength(3);
	});

	test('maxOccurrences safety cap honoured', () => {
		const event = parsedEvent({
			start: '20260401T090000Z',
			end: '20260401T100000Z',
			rrule: 'FREQ=DAILY',
		});
		const occ = expandEvent(
			event,
			new Date('2026-04-01T00:00:00Z'),
			new Date('2027-04-01T00:00:00Z'),
			{ maxOccurrences: 5 },
		);
		expect(occ).toHaveLength(5);
	});
});
