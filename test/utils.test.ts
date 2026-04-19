import {
	toCamelKey,
	normalizeParams,
	pickParam,
	sanitizeUid,
	assertSafePathSegment,
	escapeICalText,
	foldICalLine,
	buildErrorPayload,
} from '../nodes/CalDav/helpers/Utils';

describe('Utils – parameter normalisation', () => {
	test.each([
		['recurrenceCount', 'recurrenceCount'],
		['Recurrence_Count', 'recurrenceCount'],
		['RECURRENCE_COUNT', 'recurrenceCount'],
		['recurrence-count', 'recurrenceCount'],
		['recurrence count', 'recurrenceCount'],
		['uid', 'uid'],
		['UID', 'uid'],
	])('toCamelKey(%s) -> %s', (input, expected) => {
		expect(toCamelKey(input)).toBe(expected);
	});

	test('normalizeParams canonicalises keys, keeps first winner on duplicates', () => {
		const out = normalizeParams({
			Recurrence_Count: 5,
			recurrenceCount: 99,
			Event_Title: 'hi',
			UID: 'abc',
		});
		expect(out).toEqual({ recurrenceCount: 5, eventTitle: 'hi', uid: 'abc' });
	});

	test('pickParam resolves aliases', () => {
		const input = { Recurrence_Count: 5, UID: 'abc-123' };
		expect(pickParam(input, 'recurrenceCount')).toBe(5);
		expect(pickParam(input, 'uid')).toBe('abc-123');
		expect(pickParam(input, 'missing', 'fallback')).toBe('fallback');
	});
});

describe('Utils – security', () => {
	test('sanitizeUid replaces disallowed characters', () => {
		expect(sanitizeUid('abc/../def')).toBe('abc_.._def');
		expect(sanitizeUid('foo@example.com')).toBe('foo@example.com');
		expect(sanitizeUid('hello world!')).toBe('hello_world_');
		expect(sanitizeUid('keep-Valid_123.@')).toBe('keep-Valid_123.@');
	});

	test('sanitizeUid rejects empty input', () => {
		expect(() => sanitizeUid('')).toThrow();
		expect(() => sanitizeUid('   ')).toThrow();
	});

	test('assertSafePathSegment rejects traversal and // and control chars', () => {
		expect(() => assertSafePathSegment('')).toThrow();
		expect(() => assertSafePathSegment('../evil')).toThrow();
		expect(() => assertSafePathSegment('a//b')).toThrow();
		expect(() => assertSafePathSegment('ok\n')).toThrow();
		expect(() => assertSafePathSegment('ok.ics')).not.toThrow();
	});
});

describe('Utils – iCal text escaping', () => {
	test('escapes semicolons, commas, backslashes, newlines', () => {
		const input = 'Hello; world, "quoted"\\ and \n newline';
		expect(escapeICalText(input)).toBe(
			'Hello\\; world\\, "quoted"\\\\ and \\n newline',
		);
	});

	test('null / undefined => empty string', () => {
		expect(escapeICalText(null)).toBe('');
		expect(escapeICalText(undefined)).toBe('');
	});

	test('strips control characters but keeps newlines', () => {
		const input = 'abc\x00\x07def\n';
		expect(escapeICalText(input)).toBe('abcdef\\n');
	});

	test('foldICalLine folds long lines at 75 octets', () => {
		const long = 'A'.repeat(200);
		const folded = foldICalLine(long);
		const lines = folded.split('\r\n');
		expect(lines.length).toBeGreaterThan(1);
		// continuation lines start with a space
		for (let i = 1; i < lines.length; i++) {
			expect(lines[i].startsWith(' ')).toBe(true);
		}
	});
});

describe('Utils – structured error payloads', () => {
	test('includes operation, timestamp, normalised message', () => {
		const payload = buildErrorPayload(new Error('boom'), 'createEvent');
		expect(payload.success).toBe(false);
		expect(payload.error).toBe('boom');
		expect(payload.operation).toBe('createEvent');
		expect(typeof payload.timestamp).toBe('string');
		expect(new Date(payload.timestamp).toString()).not.toBe('Invalid Date');
	});

	test('accepts extra metadata', () => {
		const payload = buildErrorPayload('string error', 'getEvents', { uid: 'u1' });
		expect(payload.error).toBe('string error');
		expect(payload.uid).toBe('u1');
	});
});
