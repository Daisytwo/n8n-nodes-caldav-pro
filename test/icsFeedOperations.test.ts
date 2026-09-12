import { describe, expect, it, vi } from 'vitest';
import { CalDav } from '../nodes/CalDav/CalDav.node';
import { HOST_ZONES, withTZ } from './helpers';

/**
 * The ICS feed resource end to end through the node.
 *
 * Two things are under test: that a feed produces the same event records the
 * CalDAV path does — same recurrence, all-day and timezone handling — and that
 * nothing about the feed's address survives into the output, whatever the
 * Simplify setting and whether the run succeeds or fails.
 */

const HOST = 'feeds.example.com';
const SECRET = 's3cr3t-token';
const FEED = `https://${HOST}/calendars/${SECRET}/basic.ics`;

function vevent(uid: string, summary: string, start: string, end: string, ...extra: string[]) {
	return [
		'BEGIN:VEVENT',
		`UID:${uid}`,
		'DTSTAMP:20260101T000000Z',
		`DTSTART:${start}`,
		`DTEND:${end}`,
		`SUMMARY:${summary}`,
		...extra,
		'END:VEVENT',
	].join('\r\n');
}

function feed(...events: string[]) {
	return [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//Example Feeds//EN',
		'X-WR-CALNAME:Public',
		...events,
		'END:VCALENDAR',
	].join('\r\n');
}

/** An iCalendar UTC stamp, for windows expressed relative to now. */
function stamp(date: Date) {
	return `${date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;
}

interface Options {
	params: Record<string, unknown>;
	body?: string;
	feedName?: string;
	feedUrl?: string;
	itemCount?: number;
	continueOnFail?: boolean;
	timezone?: string;
}

function makeContext(opts: Options) {
	const httpRequest = vi.fn(async () => ({
		statusCode: 200,
		headers: { 'content-type': 'text/calendar' },
		body: opts.body ?? feed(),
	}));
	const httpRequestWithAuthentication = vi.fn(async () => {
		throw new Error('a feed must never be fetched with a credential attached');
	});
	const getCredentials = vi.fn(async (name: string) => {
		if (name === 'icsFeedApi') {
			return { feedUrl: opts.feedUrl ?? FEED, feedName: opts.feedName ?? 'Public Holidays' };
		}
		// Reading the CalDAV credential at all would be a defect: this resource
		// has nothing to authenticate with, and must not require an account.
		throw new Error(`credential "${name}" must not be requested for an ICS feed`);
	});

	return {
		httpRequest,
		httpRequestWithAuthentication,
		getCredentials,
		getInputData: () => Array.from({ length: opts.itemCount ?? 1 }, () => ({ json: {} })),
		getNode: () => ({ name: 'CalDAV', type: 'calDav', typeVersion: 1, id: 'n1' }),
		getTimezone: () => opts.timezone ?? 'Europe/Berlin',
		getNodeParameter: (name: string, _i: number, fallback?: unknown) =>
			name in opts.params ? opts.params[name] : fallback,
		continueOnFail: () => opts.continueOnFail ?? false,
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		helpers: { httpRequest, httpRequestWithAuthentication },
	};
}

async function run(opts: Options) {
	const ctx = makeContext(opts);
	const [items] = await new CalDav().execute.call(ctx as any);
	return { items: items.map((x) => x.json as Record<string, any>), ctx };
}

const base = { resource: 'icsFeed', returnAll: true, simplify: true };
const WINDOW = { timeMin: '2026-04-01T00:00:00Z', timeMax: '2026-05-01T00:00:00Z' };

describe('ICS feed — Get Many', () => {
	it('returns the events in the window, sorted by start, labelled with the feed', async () => {
		const { items } = await run({
			params: { ...base, operation: 'getAll', ...WINDOW },
			body: feed(
				vevent('b', 'Later', '20260420T120000Z', '20260420T130000Z'),
				vevent('a', 'Earlier', '20260405T090000Z', '20260405T100000Z'),
			),
		});
		expect(items.map((e) => e.summary)).toEqual(['Earlier', 'Later']);
		expect(items[0].start).toBe('2026-04-05T09:00:00.000Z');
		expect(items[0].source).toBe('icsFeed');
		expect(items[0].feedName).toBe('Public Holidays');
	});

	it('drops events outside the window, which a feed serves regardless', async () => {
		const { items } = await run({
			params: { ...base, operation: 'getAll', ...WINDOW },
			body: feed(
				vevent('old', 'Last year', '20250405T090000Z', '20250405T100000Z'),
				vevent('now', 'Inside', '20260405T090000Z', '20260405T100000Z'),
				vevent('future', 'Next year', '20270405T090000Z', '20270405T100000Z'),
			),
		});
		expect(items.map((e) => e.summary)).toEqual(['Inside']);
	});

	it('keeps an event that overlaps the start of the window', async () => {
		const { items } = await run({
			params: { ...base, operation: 'getAll', timeMin: '2026-04-05T09:30:00Z', timeMax: '2026-04-06T00:00:00Z' },
			body: feed(vevent('a', 'Ongoing', '20260405T090000Z', '20260405T100000Z')),
		});
		expect(items.map((e) => e.summary)).toEqual(['Ongoing']);
	});

	it('never carries a resource URL, ETag or calendar URL into the output', async () => {
		const { items } = await run({
			params: { ...base, operation: 'getAll', ...WINDOW },
			body: feed(vevent('a', 'Meeting', '20260405T090000Z', '20260405T100000Z')),
		});
		expect(items[0]).not.toHaveProperty('url');
		expect(items[0]).not.toHaveProperty('etag');
		expect(items[0]).not.toHaveProperty('calendarUrl');
		expect(items[0]).not.toHaveProperty('calendarName');
		expect(items[0]).not.toHaveProperty('raw');
	});

	it('omits feedName when the credential does not set one', async () => {
		const { items } = await run({
			params: { ...base, operation: 'getAll', ...WINDOW },
			feedName: '   ',
			body: feed(vevent('a', 'Meeting', '20260405T090000Z', '20260405T100000Z')),
		});
		expect(items[0]).not.toHaveProperty('feedName');
		expect(items[0].source).toBe('icsFeed');
	});

	it('honours the limit and Return All', async () => {
		const body = feed(
			vevent('a', 'One', '20260405T090000Z', '20260405T100000Z'),
			vevent('b', 'Two', '20260406T090000Z', '20260406T100000Z'),
			vevent('c', 'Three', '20260407T090000Z', '20260407T100000Z'),
		);
		const limited = await run({
			params: { ...base, operation: 'getAll', ...WINDOW, returnAll: false, limit: 2 },
			body,
		});
		expect(limited.items.map((e) => e.summary)).toEqual(['One', 'Two']);

		const all = await run({ params: { ...base, operation: 'getAll', ...WINDOW }, body });
		expect(all.items).toHaveLength(3);
	});
});

describe('ICS feed — parsing parity with CalDAV', () => {
	it('expands a recurring series into occurrences and applies EXDATE', async () => {
		const { items } = await run({
			params: { ...base, operation: 'getAll', ...WINDOW },
			body: feed(
				vevent(
					'weekly',
					'Standup',
					'20260406T080000Z',
					'20260406T081500Z',
					'RRULE:FREQ=WEEKLY;COUNT=4',
					'EXDATE:20260413T080000Z',
				),
			),
		});
		expect(items.map((e) => e.start)).toEqual([
			'2026-04-06T08:00:00.000Z',
			'2026-04-20T08:00:00.000Z',
			'2026-04-27T08:00:00.000Z',
		]);
		expect(items[0].recurrenceId).toBe('2026-04-06T08:00:00.000Z');
		expect(items[0].rrule).toContain('FREQ=WEEKLY');
	});

	it('applies a RECURRENCE-ID override that sits beside its master in the feed', async () => {
		const { items } = await run({
			params: { ...base, operation: 'getAll', ...WINDOW },
			body: feed(
				vevent('weekly', 'Standup', '20260406T080000Z', '20260406T081500Z', 'RRULE:FREQ=WEEKLY;COUNT=2'),
				vevent(
					'weekly',
					'Standup (moved)',
					'20260413T100000Z',
					'20260413T101500Z',
					'RECURRENCE-ID:20260413T080000Z',
				),
			),
		});
		expect(items.map((e) => e.summary)).toEqual(['Standup', 'Standup (moved)']);
		expect(items[1].start).toBe('2026-04-13T10:00:00.000Z');
	});

	it('reports an all-day event as a bare date', async () => {
		const { items } = await run({
			params: { ...base, operation: 'getAll', ...WINDOW },
			body: feed(
				[
					'BEGIN:VEVENT',
					'UID:holiday',
					'DTSTAMP:20260101T000000Z',
					'DTSTART;VALUE=DATE:20260406',
					'DTEND;VALUE=DATE:20260407',
					'SUMMARY:Ostermontag',
					'END:VEVENT',
				].join('\r\n'),
			),
		});
		expect(items[0].allDay).toBe(true);
		expect(items[0].start).toBe('2026-04-06');
		expect(items[0].end).toBe('2026-04-07');
	});

	it('reads a TZID against the platform database, whatever the host zone is', async () => {
		const body = feed(
			[
				'BEGIN:VEVENT',
				'UID:tz',
				'DTSTAMP:20260101T000000Z',
				'DTSTART;TZID=Europe/Berlin:20260420T140000',
				'DTEND;TZID=Europe/Berlin:20260420T150000',
				'SUMMARY:Termin',
				'END:VEVENT',
			].join('\r\n'),
		);
		for (const zone of HOST_ZONES) {
			const { items } = await withTZ(zone, () =>
				run({ params: { ...base, operation: 'getAll', ...WINDOW }, body }),
			);
			expect(items[0].start).toBe('2026-04-20T12:00:00.000Z');
			expect(items[0].startLocal).toBe('2026-04-20T14:00:00+02:00');
			expect(items[0].timezone).toBe('Europe/Berlin');
		}
	});
});

describe('ICS feed — Get Next and Search', () => {
	it('returns only events still ahead, nearest first', async () => {
		const now = Date.now();
		const { items } = await run({
			params: { ...base, operation: 'getNext', lookaheadDays: 30, returnAll: false, limit: 2 },
			body: feed(
				vevent('past', 'Yesterday', stamp(new Date(now - 86400000)), stamp(new Date(now - 82800000))),
				vevent('soon', 'In two hours', stamp(new Date(now + 7200000)), stamp(new Date(now + 10800000))),
				vevent('later', 'Tomorrow', stamp(new Date(now + 86400000)), stamp(new Date(now + 90000000))),
				vevent('far', 'In a year', stamp(new Date(now + 365 * 86400000)), stamp(new Date(now + 365 * 86400000 + 3600000))),
			),
		});
		expect(items.map((e) => e.summary)).toEqual(['In two hours', 'Tomorrow']);
	});

	it('matches the query against title, description and location', async () => {
		const body = feed(
			vevent('a', 'Zahnarzt', '20260405T090000Z', '20260405T100000Z'),
			vevent('b', 'Standup', '20260406T090000Z', '20260406T100000Z', 'LOCATION:Zahnarztpraxis'),
			vevent('c', 'Kickoff', '20260407T090000Z', '20260407T100000Z', 'DESCRIPTION:mit Alice'),
		);
		const dentist = await run({
			params: { ...base, operation: 'search', ...WINDOW, query: 'zahnarzt' },
			body,
		});
		expect(dentist.items.map((e) => e.summary)).toEqual(['Zahnarzt', 'Standup']);

		const alice = await run({
			params: { ...base, operation: 'search', ...WINDOW, query: 'Alice' },
			body,
		});
		expect(alice.items.map((e) => e.summary)).toEqual(['Kickoff']);
	});

	it('rejects a write operation on a read-only feed', async () => {
		await expect(
			run({ params: { ...base, operation: 'create', ...WINDOW } }),
		).rejects.toThrow(/read-only|Unknown ICS feed operation/i);
	});
});

describe('ICS feed — the request path', () => {
	it('fetches once per execution, unauthenticated, without asking for the CalDAV credential', async () => {
		const { items, ctx } = await run({
			params: { ...base, operation: 'getAll', ...WINDOW },
			itemCount: 3,
			body: feed(vevent('a', 'Meeting', '20260405T090000Z', '20260405T100000Z')),
		});
		expect(items).toHaveLength(3);
		expect(ctx.httpRequest).toHaveBeenCalledTimes(1);
		expect(ctx.httpRequestWithAuthentication).not.toHaveBeenCalled();
		expect(ctx.getCredentials.mock.calls.map((c) => c[0])).toEqual(['icsFeedApi']);
	});
});

describe('ICS feed — the feed address never reaches the output', () => {
	const body = feed(
		vevent('a', 'Meeting', '20260405T090000Z', '20260405T100000Z', 'DESCRIPTION:Nothing secret here'),
		vevent(
			'weekly',
			'Standup',
			'20260406T080000Z',
			'20260406T081500Z',
			'RRULE:FREQ=WEEKLY;COUNT=3',
		),
	);

	it.each([true, false])('keeps host and token out of the output with simplify %s', async (simplify) => {
		const { items } = await run({
			params: { ...base, operation: 'getAll', ...WINDOW, simplify },
			body,
		});
		expect(items.length).toBeGreaterThan(1);
		// Simplify off still has to return the source — just not the address.
		expect(Boolean(items[0].raw)).toBe(!simplify);

		const serialised = JSON.stringify(items);
		expect(serialised).not.toContain(HOST);
		expect(serialised).not.toContain(SECRET);
		expect(serialised).not.toContain(FEED);
	});

	it('keeps host and token out of a failure reported through continueOnFail', async () => {
		const { items } = await run({
			params: { ...base, operation: 'getAll', ...WINDOW },
			feedUrl: `http://${HOST}/calendars/${SECRET}/basic.ics`,
			continueOnFail: true,
		});
		const serialised = JSON.stringify(items);
		expect(items[0].error).toBeTruthy();
		expect(serialised).not.toContain(HOST);
		expect(serialised).not.toContain(SECRET);
	});

	it('keeps host and token out of a thrown node error', async () => {
		let thrown: any;
		try {
			await run({
				params: { ...base, operation: 'getAll', ...WINDOW },
				feedUrl: `https://127.0.0.1/${SECRET}.ics`,
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeTruthy();
		const serialised = JSON.stringify({
			message: thrown.message,
			description: thrown.description,
			context: thrown.context,
		});
		expect(serialised).not.toContain(SECRET);
		expect(serialised).not.toContain('127.0.0.1');
	});

	it('keeps host and token out of a failed fetch', async () => {
		const ctx = makeContext({ params: { ...base, operation: 'getAll', ...WINDOW } });
		ctx.httpRequest.mockImplementation(async () => {
			const error: any = new Error(`getaddrinfo ENOTFOUND ${HOST}`);
			error.code = 'ENOTFOUND';
			throw error;
		});
		await expect(new CalDav().execute.call(ctx as any)).rejects.toThrow(
			/could not be fetched/i,
		);
		await expect(new CalDav().execute.call(ctx as any)).rejects.not.toThrow(
			new RegExp(HOST.replace(/\./g, '\\.')),
		);
	});
});

describe('ICS feed — node description', () => {
	const description = new CalDav().description;

	it('does not require a CalDAV account in the editor for a feed', () => {
		const calDav = description.credentials?.find((c) => c.name === 'calDavApi');
		expect(calDav?.required).toBe(false);
		expect(calDav?.displayOptions).toBeUndefined();
	});

	it('makes the ICS credential selectable without resource gating', () => {
		const feedCredential = description.credentials?.find((c) => c.name === 'icsFeedApi');
		expect(feedCredential?.required).toBe(false);
		expect(feedCredential?.displayOptions).toBeUndefined();
	});

	it('offers only read operations on the feed resource', () => {
		const operations = description.properties.find(
			(p) => p.name === 'operation' && p.displayOptions?.show?.resource?.includes('icsFeed'),
		);
		expect((operations?.options ?? []).map((o: any) => o.value)).toEqual([
			'getAll',
			'getNext',
			'search',
		]);
	});
});
