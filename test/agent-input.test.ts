/**
 * Tests for `normalizeAgentInput` — the helper that makes the CalDAV tool
 * robust against the many payload shapes real AI Agents emit.
 */

import { extractOperation, normalizeAgentInput } from '../nodes/CalDav/helpers/AgentInput';

describe('normalizeAgentInput', () => {
	test('flat canonical payload is returned as-is (aliases preserved)', () => {
		const out = normalizeAgentInput({
			operation: 'createEvent',
			eventTitle: 'Meeting',
			startDateAndTime: '2026-04-14T12:00:00+02:00',
			endDateAndTime: '2026-04-14T13:00:00+02:00',
		});
		expect(out.operation).toBe('createEvent');
		expect(out.eventTitle).toBe('Meeting');
		expect(out.startDateAndTime).toBe('2026-04-14T12:00:00+02:00');
		expect(out.endDateAndTime).toBe('2026-04-14T13:00:00+02:00');
	});

	test('nested `event` object is flattened and summary/start/end are remapped', () => {
		const out = normalizeAgentInput({
			operation: 'createEvent',
			event: {
				summary: 'Team sync',
				start: '2026-04-14T12:00:00+02:00',
				end: '2026-04-14T13:00:00+02:00',
				location: 'Berlin',
			},
		});
		expect(out.operation).toBe('createEvent');
		expect(out.eventTitle).toBe('Team sync');
		expect(out.startDateAndTime).toBe('2026-04-14T12:00:00+02:00');
		expect(out.endDateAndTime).toBe('2026-04-14T13:00:00+02:00');
		expect(out.location).toBe('Berlin');
	});

	test('top-level fields win over nested ones', () => {
		const out = normalizeAgentInput({
			operation: 'createEvent',
			eventTitle: 'Top Wins',
			event: {
				summary: 'Nested',
				start: '2026-04-14T12:00:00+02:00',
			},
		});
		expect(out.eventTitle).toBe('Top Wins');
		expect(out.startDateAndTime).toBe('2026-04-14T12:00:00+02:00');
	});

	test('unwraps `arguments` wrapper objects', () => {
		const out = normalizeAgentInput({
			arguments: {
				operation: 'deleteEvent',
				uid: 'abc-123',
			},
		});
		expect(out.operation).toBe('deleteEvent');
		expect(out.uid).toBe('abc-123');
	});

	test('flattens a sibling `parameters` container (operation stays on top)', () => {
		const out = normalizeAgentInput({
			operation: 'createEvent',
			parameters: {
				title: 'Review',
				start: '2026-04-14T12:00:00+02:00',
				end: '2026-04-14T13:00:00+02:00',
			},
		});
		expect(out.operation).toBe('createEvent');
		expect(out.eventTitle).toBe('Review');
		expect(out.startDateAndTime).toBe('2026-04-14T12:00:00+02:00');
		expect(out.endDateAndTime).toBe('2026-04-14T13:00:00+02:00');
	});

	test('flattens sibling `params` / `args` containers', () => {
		const out = normalizeAgentInput({
			operation: 'createEvent',
			params: { summary: 'Via params', start: '2026-04-14T12:00:00+02:00' },
		});
		expect(out.operation).toBe('createEvent');
		expect(out.eventTitle).toBe('Via params');
		expect(out.startDateAndTime).toBe('2026-04-14T12:00:00+02:00');
	});

	test('unwraps `input` wrapper objects', () => {
		const out = normalizeAgentInput({
			input: { operation: 'getEvents', date: '2026-04-14' },
		});
		expect(out.operation).toBe('getEvents');
		expect(out.date).toBe('2026-04-14');
	});

	test('maps `allDay` → `allDayEvent` and `notes` → `description`', () => {
		const out = normalizeAgentInput({
			operation: 'createEvent',
			title: 'Vacation',
			start: '2026-08-01',
			end: '2026-08-15',
			allDay: true,
			notes: 'Out of office',
		});
		expect(out.eventTitle).toBe('Vacation');
		expect(out.allDayEvent).toBe(true);
		expect(out.description).toBe('Out of office');
	});

	test('maps recurrence aliases', () => {
		const out = normalizeAgentInput({
			operation: 'createEvent',
			title: 'Standup',
			start: '2026-04-14T09:00:00+02:00',
			end: '2026-04-14T09:15:00+02:00',
			recurring: true,
			frequency: 'WEEKLY',
			interval: 1,
			count: 10,
			byDay: 'MO,TU,WE,TH,FR',
		});
		expect(out.recurringEvent).toBe(true);
		expect(out.recurrenceFrequency).toBe('WEEKLY');
		expect(out.recurrenceInterval).toBe(1);
		expect(out.recurrenceCount).toBe(10);
		expect(out.recurrenceByDay).toBe('MO,TU,WE,TH,FR');
	});

	test('nested `recurrence` object is flattened', () => {
		const out = normalizeAgentInput({
			operation: 'createEvent',
			eventTitle: 'Standup',
			startDateAndTime: '2026-04-14T09:00:00+02:00',
			endDateAndTime: '2026-04-14T09:15:00+02:00',
			recurrence: {
				frequency: 'DAILY',
				interval: 2,
				count: 5,
			},
		});
		expect(out.recurrenceFrequency).toBe('DAILY');
		expect(out.recurrenceInterval).toBe(2);
		expect(out.recurrenceCount).toBe(5);
	});

	test('accepts JSON strings', () => {
		const out = normalizeAgentInput(
			JSON.stringify({
				operation: 'createEvent',
				event: {
					summary: 'From JSON',
					start: '2026-04-14T12:00:00+02:00',
					end: '2026-04-14T13:00:00+02:00',
				},
			}),
		);
		expect(out.operation).toBe('createEvent');
		expect(out.eventTitle).toBe('From JSON');
		expect(out.startDateAndTime).toBe('2026-04-14T12:00:00+02:00');
	});

	test('bare non-JSON string becomes eventTitle', () => {
		const out = normalizeAgentInput('Grocery run');
		expect(out.eventTitle).toBe('Grocery run');
	});

	test('snake_case / kebab-case / UPPER_CASE aliases still resolve', () => {
		const out = normalizeAgentInput({
			operation: 'createEvent',
			'start-time': '2026-04-14T12:00:00+02:00',
			END_TIME: '2026-04-14T13:00:00+02:00',
			is_all_day: false,
		});
		expect(out.startDateAndTime).toBe('2026-04-14T12:00:00+02:00');
		expect(out.endDateAndTime).toBe('2026-04-14T13:00:00+02:00');
		expect(out.allDayEvent).toBe(false);
	});

	test('empty / null / undefined inputs produce empty object', () => {
		expect(normalizeAgentInput(null)).toEqual({});
		expect(normalizeAgentInput(undefined)).toEqual({});
		expect(normalizeAgentInput('')).toEqual({});
		expect(normalizeAgentInput({})).toEqual({});
	});

	test('drops empty strings and undefined values', () => {
		const out = normalizeAgentInput({
			operation: 'createEvent',
			eventTitle: '',
			location: undefined,
			description: 'keep',
		});
		expect(out.eventTitle).toBeUndefined();
		expect(out.location).toBeUndefined();
		expect(out.description).toBe('keep');
	});
});

describe('extractOperation', () => {
	test('reads from `operation`', () => {
		expect(extractOperation({ operation: 'createEvent' })).toBe('createEvent');
	});

	test('falls through to `action` / `tool` / `type`', () => {
		expect(extractOperation({ action: 'deleteEvent' })).toBe('deleteEvent');
		expect(extractOperation({ tool: 'getEvents' })).toBe('getEvents');
		expect(extractOperation({ type: 'updateEvent' })).toBe('updateEvent');
	});

	test('trims whitespace', () => {
		expect(extractOperation({ operation: '  createEvent  ' })).toBe('createEvent');
	});

	test('returns undefined when no operation field is present', () => {
		expect(extractOperation({ foo: 'bar' })).toBeUndefined();
		expect(extractOperation({ operation: '' })).toBeUndefined();
		expect(extractOperation({ operation: '   ' })).toBeUndefined();
	});
});
