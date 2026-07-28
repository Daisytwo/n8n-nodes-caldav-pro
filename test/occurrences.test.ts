import { describe, expect, it } from 'vitest';
import {
	expandCalendarObject,
	patchOccurrence,
	removeOccurrence,
} from '../nodes/CalDav/GenericFunctions';

const URL = 'https://example.com/cal/series.ics';
const WINDOW = { from: new Date('2026-04-01T00:00:00Z'), to: new Date('2026-05-10T00:00:00Z') };

const series = [
	'BEGIN:VCALENDAR',
	'VERSION:2.0',
	'PRODID:-//x//EN',
	'BEGIN:VEVENT',
	'UID:jf',
	'DTSTAMP:20260101T000000Z',
	'DTSTART;TZID=Europe/Berlin:20260406T100000',
	'DTEND;TZID=Europe/Berlin:20260406T110000',
	'SUMMARY:Jour fixe',
	'DESCRIPTION:Agenda',
	'LOCATION:Room 3',
	'CATEGORIES:work',
	'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4',
	'SEQUENCE:2',
	'END:VEVENT',
	'END:VCALENDAR',
].join('\r\n');

const occurrences = (ics: string) => expandCalendarObject(ics, URL, undefined, WINDOW.from, WINDOW.to);
const starts = (ics: string) => occurrences(ics).map((e) => e.startLocal);
/** The recurrenceId a read operation would hand back for the nth occurrence. */
const idOf = (n: number) => occurrences(series)[n].recurrenceId!;

describe('removeOccurrence', () => {
	it('cancels one date and leaves the rest', () => {
		const out = removeOccurrence(series, idOf(1));
		expect(starts(series)).toHaveLength(4);
		expect(starts(out)).toEqual([
			'2026-04-06T10:00:00+02:00',
			'2026-04-20T10:00:00+02:00',
			'2026-04-27T10:00:00+02:00',
		]);
	});

	it('writes EXDATE in the same form as DTSTART', () => {
		const out = removeOccurrence(series, idOf(1));
		expect(out).toContain('EXDATE;TZID=Europe/Berlin:20260413T100000');
	});

	it('accumulates rather than replacing a previous exclusion', () => {
		const twice = removeOccurrence(removeOccurrence(series, idOf(1)), idOf(2));
		expect(starts(twice)).toEqual(['2026-04-06T10:00:00+02:00', '2026-04-27T10:00:00+02:00']);
	});

	it('removes an override for the same slot instead of orphaning it', () => {
		// Moving an occurrence and then cancelling it must not leave the moved
		// copy behind — the server would keep returning it.
		const moved = patchOccurrence(series, idOf(1), {
			start: '2026-04-13T16:00:00+02:00',
			end: '2026-04-13T17:00:00+02:00',
		});
		expect(starts(moved)).toContain('2026-04-13T16:00:00+02:00');
		const cancelled = removeOccurrence(moved, idOf(1));
		expect(starts(cancelled)).toEqual([
			'2026-04-06T10:00:00+02:00',
			'2026-04-20T10:00:00+02:00',
			'2026-04-27T10:00:00+02:00',
		]);
		expect(cancelled).not.toContain('RECURRENCE-ID');
	});

	it('rejects a recurrenceId that names no occurrence', () => {
		expect(() => removeOccurrence(series, '2026-04-14T08:00:00.000Z')).toThrow(
			/No occurrence of this series starts at/,
		);
	});

	it('bumps SEQUENCE on the master', () => {
		expect(removeOccurrence(series, idOf(1))).toContain('SEQUENCE:3');
	});
});

describe('patchOccurrence', () => {
	it('moves one occurrence and leaves the others', () => {
		const out = patchOccurrence(series, idOf(1), {
			summary: 'Jour fixe (moved)',
			start: '2026-04-13T16:00:00+02:00',
			end: '2026-04-13T17:00:00+02:00',
		});
		expect(starts(out)).toEqual([
			'2026-04-06T10:00:00+02:00',
			'2026-04-13T16:00:00+02:00',
			'2026-04-20T10:00:00+02:00',
			'2026-04-27T10:00:00+02:00',
		]);
		const moved = occurrences(out).find((e) => e.startLocal === '2026-04-13T16:00:00+02:00');
		expect(moved!.summary).toBe('Jour fixe (moved)');
		expect(occurrences(out)[0].summary).toBe('Jour fixe');
	});

	it('anchors the override on the slot the rule generated', () => {
		// RECURRENCE-ID must name the original slot, not where it was moved to.
		const out = patchOccurrence(series, idOf(1), {
			start: '2026-04-13T16:00:00+02:00',
			end: '2026-04-13T17:00:00+02:00',
		});
		expect(out).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20260413T100000');
	});

	it('does not let the override define a second series', () => {
		const out = patchOccurrence(series, idOf(1), { summary: 'Renamed' });
		const overrideBlock = out.slice(out.indexOf('RECURRENCE-ID'));
		expect(overrideBlock).not.toContain('RRULE');
	});

	it('inherits the series details the patch does not mention', () => {
		const out = patchOccurrence(series, idOf(2), { summary: 'Renamed' });
		const target = occurrences(out).find((e) => e.summary === 'Renamed')!;
		expect(target.description).toBe('Agenda');
		expect(target.location).toBe('Room 3');
		expect(out).toContain('CATEGORIES:work');
	});

	it('keeps the original time when only the title changes', () => {
		const out = patchOccurrence(series, idOf(1), { summary: 'Renamed' });
		expect(starts(out)).toEqual(starts(series));
	});

	it('updates an existing override rather than adding a second', () => {
		const once = patchOccurrence(series, idOf(1), { summary: 'First' });
		const twice = patchOccurrence(once, idOf(1), { summary: 'Second' });
		expect(twice.match(/RECURRENCE-ID/g)).toHaveLength(1);
		expect(starts(twice)).toHaveLength(4);
		expect(occurrences(twice).some((e) => e.summary === 'Second')).toBe(true);
		expect(occurrences(twice).some((e) => e.summary === 'First')).toBe(false);
	});

	it('rejects a recurrenceId that names no occurrence', () => {
		expect(() => patchOccurrence(series, '2026-04-14T08:00:00.000Z', { summary: 'x' })).toThrow(
			/No occurrence of this series starts at/,
		);
	});
});

describe('occurrences of an all-day series', () => {
	const allDay = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//x//EN',
		'BEGIN:VEVENT',
		'UID:ad',
		'DTSTAMP:20260101T000000Z',
		'DTSTART;VALUE=DATE:20260406',
		'DTEND;VALUE=DATE:20260407',
		'SUMMARY:Daily',
		'RRULE:FREQ=DAILY;COUNT=3',
		'END:VEVENT',
		'END:VCALENDAR',
	].join('\r\n');

	it('excludes a date using a DATE-valued EXDATE', () => {
		const ids = expandCalendarObject(allDay, URL, undefined, WINDOW.from, WINDOW.to).map(
			(e) => e.recurrenceId!,
		);
		const out = removeOccurrence(allDay, ids[1]);
		expect(out).toContain('EXDATE;VALUE=DATE:20260407');
		expect(
			expandCalendarObject(out, URL, undefined, WINDOW.from, WINDOW.to).map((e) => e.start),
		).toEqual(['2026-04-06', '2026-04-08']);
	});
});
