import { describe, expect, it, vi } from 'vitest';
import {
	buildUidQueryReport,
	resolveEventUrl,
	simplifyEvent,
	type CalDavEvent,
} from '../nodes/CalDav/GenericFunctions';

const CAL = 'https://example.com/calendars/user/work/';
const SERVER = 'https://example.com/';

function multistatus(...hrefs: string[]): string {
	return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${hrefs
		.map(
			(h) =>
				`<d:response><d:href>${h}</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop><d:getetag>"e"</d:getetag></d:prop></d:propstat></d:response>`,
		)
		.join('')}</d:multistatus>`;
}

/**
 * Minimal stand-in for the n8n execution context. `respond` decides what the
 * REPORT returns, so each test can drive one branch of the lookup.
 */
function ctx(respond: (opts: any) => any) {
	const calls: any[] = [];
	return {
		calls,
		getNode: () => ({ name: 'CalDAV', type: 'calDav', typeVersion: 1, id: 't' }),
		logger: { debug: vi.fn() },
		helpers: {
			httpRequestWithAuthentication: vi.fn(async (_cred: string, opts: any) => {
				calls.push(opts);
				return respond(opts);
			}),
		},
	};
}

const ok = (body: string) => ({ statusCode: 207, body, headers: {} });

describe('buildUidQueryReport', () => {
	it('filters on the UID and asks for no calendar data', () => {
		const xml = buildUidQueryReport('abc-123');
		expect(xml).toContain('<c:prop-filter name="UID">');
		expect(xml).toContain('>abc-123<');
		expect(xml).not.toContain('calendar-data');
	});

	it('escapes XML metacharacters in the UID', () => {
		// A UID is server-generated and may legitimately contain these.
		const xml = buildUidQueryReport('a&b<c>"d\'');
		expect(xml).toContain('a&amp;b&lt;c&gt;&quot;d&apos;');
		expect(xml).not.toMatch(/>a&b<c>/);
	});
});

describe('resolveEventUrl', () => {
	it('uses an explicit URL without contacting the server', async () => {
		const c = ctx(() => {
			throw new Error('should not be called');
		});
		const url = await resolveEventUrl.call(
			c as any,
			CAL,
			'some-uid',
			'https://example.com/calendars/user/work/apple-generated.ics',
			SERVER,
		);
		expect(url).toBe('https://example.com/calendars/user/work/apple-generated.ics');
		expect(c.calls).toHaveLength(0);
	});

	it('absolutises a path-only URL against the server', async () => {
		const c = ctx(() => ok(multistatus()));
		const url = await resolveEventUrl.call(
			c as any,
			CAL,
			'',
			'/calendars/user/work/abc.ics',
			SERVER,
		);
		expect(url).toBe('https://example.com/calendars/user/work/abc.ics');
	});

	it('finds the real resource name via a UID query', async () => {
		// The whole point of P0-4: the file is not named after the UID.
		const c = ctx(() => ok(multistatus('/calendars/user/work/20260420T090000-4711@apple.ics')));
		const url = await resolveEventUrl.call(c as any, CAL, 'series-uid', undefined, SERVER);
		expect(url).toBe('https://example.com/calendars/user/work/20260420T090000-4711@apple.ics');
		expect(c.calls[0].method).toBe('REPORT');
		expect(c.calls[0].body).toContain('series-uid');
	});

	it('falls back to the <uid>.ics convention when the query finds nothing', async () => {
		const c = ctx(() => ok(multistatus()));
		const url = await resolveEventUrl.call(c as any, CAL, 'made-by-this-node', undefined, SERVER);
		expect(url).toBe(`${CAL}made-by-this-node.ics`);
	});

	it('falls back when the server rejects the query outright', async () => {
		// Not every server supports prop-filter; a 403 must not break Delete.
		const c = ctx(() => ({ statusCode: 403, body: 'forbidden', headers: {} }));
		const url = await resolveEventUrl.call(c as any, CAL, 'legacy-uid', undefined, SERVER);
		expect(url).toBe(`${CAL}legacy-uid.ics`);
	});

	it('percent-encodes a UID that is unsafe in a path', async () => {
		const c = ctx(() => ok(multistatus()));
		const url = await resolveEventUrl.call(c as any, CAL, 'a b/c?d', undefined, SERVER);
		expect(url).toBe(`${CAL}a%20b%2Fc%3Fd.ics`);
	});

	it('takes the first match and notes the ambiguity', async () => {
		const c = ctx(() => ok(multistatus('/cal/one.ics', '/cal/two.ics')));
		const url = await resolveEventUrl.call(c as any, CAL, 'dup', undefined, SERVER);
		expect(url).toBe('https://example.com/cal/one.ics');
		expect(c.logger.debug).toHaveBeenCalledWith(expect.stringContaining('matched 2'));
	});
});

describe('simplifyEvent', () => {
	const event: CalDavEvent = {
		uid: 'u',
		url: 'https://example.com/cal/u.ics',
		summary: 'Standup',
		start: '2026-04-20T12:00:00.000Z',
		end: '2026-04-20T13:00:00.000Z',
		allDay: false,
		timezone: 'Europe/Berlin',
		recurrenceId: '2026-04-20T12:00:00.000Z',
		attendees: ['alice@example.com'],
		raw: 'BEGIN:VCALENDAR\r\n…\r\nEND:VCALENDAR',
	};

	it('drops only the raw payload', () => {
		const out = simplifyEvent(event);
		expect(out).not.toHaveProperty('raw');
		const { raw, ...withoutRaw } = event;
		expect(raw).toBeDefined();
		expect(out).toEqual(withoutRaw);
	});

	it('keeps every field a workflow acts on', () => {
		const out = simplifyEvent(event) as Record<string, unknown>;
		for (const key of [
			'uid',
			'url',
			'summary',
			'start',
			'end',
			'allDay',
			'timezone',
			'recurrenceId',
			'attendees',
		]) {
			expect(out[key]).toEqual((event as Record<string, unknown>)[key]);
		}
	});

	it('does not mutate the input', () => {
		simplifyEvent(event);
		expect(event.raw).toBeDefined();
	});
});
