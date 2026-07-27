import { describe, expect, it, vi } from 'vitest';
import { CalDav } from '../nodes/CalDav/CalDav.node';

const SERVER = 'https://dav.example.com/';
const WORK = 'https://dav.example.com/calendars/bob/work/';
const HOME = 'https://dav.example.com/calendars/bob/home/';

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

function calendarData(...events: string[]) {
	return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//x//EN', ...events, 'END:VCALENDAR'].join(
		'\r\n',
	);
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function eventsMultistatus(entries: Array<{ href: string; ics: string }>) {
	return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${entries
		.map(
			(e) =>
				`<d:response><d:href>${e.href}</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop><d:getetag>"t"</d:getetag><c:calendar-data>${xmlEscape(
					e.ics,
				)}</c:calendar-data></d:prop></d:propstat></d:response>`,
		)
		.join('')}</d:multistatus>`;
}

interface Options {
	params: Record<string, unknown>;
	events?: Record<string, Array<{ href: string; ics: string }>>;
	reportFails?: string[];
	/** Number of input items the node is executed over. */
	itemCount?: number;
	/** Set false to simulate a server that reports no privileges at all. */
	reportPrivileges?: boolean;
	/** Set false to make the "Home" calendar read-only. */
	homeWritable?: boolean;
	/** Calendar URLs whose PUT/DELETE should return 403. */
	writeFails?: string[];
	/** iCalendar returned by GET on a single event resource. */
	storedEvent?: string;
}

/**
 * A fake n8n execution context. Discovery is answered by inspecting the
 * PROPFIND body, so the node walks its real request chain.
 */
function makeContext(opts: Options) {
	const requests: Array<{ method: string; url: string }> = [];
	const httpRequestWithAuthentication = vi.fn(async (_cred: string, o: any) => {
		requests.push({ method: o.method, url: o.url });
		const body = String(o.body ?? '');
		if (o.method === 'PROPFIND') {
			if (body.includes('current-user-principal')) {
				return {
					statusCode: 207,
					headers: {},
					body: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop><d:current-user-principal><d:href>/principals/bob/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>`,
				};
			}
			if (body.includes('calendar-home-set')) {
				return {
					statusCode: 207,
					headers: {},
					body: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/principals/bob/</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop><c:calendar-home-set><d:href>/calendars/bob/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response></d:multistatus>`,
				};
			}
			// Calendar collection listing.
			const privileges = (writable: boolean) =>
				opts.reportPrivileges === false
					? ''
					: `<d:current-user-privilege-set>${(writable ? ['read', 'write'] : ['read'])
							.map((p) => `<d:privilege><d:${p}/></d:privilege>`)
							.join('')}</d:current-user-privilege-set>`;
			const collection = (href: string, name: string, writable = true) =>
				`<d:response><d:href>${href}</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${name}</d:displayname>${privileges(writable)}</d:prop></d:propstat></d:response>`;
			return {
				statusCode: 207,
				headers: {},
				body: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${collection(
					'/calendars/bob/work/',
					'Work',
				)}${collection('/calendars/bob/home/', 'Home', opts.homeWritable !== false)}</d:multistatus>`,
			};
		}
		if (o.method === 'GET') {
			const ics = opts.storedEvent;
			if (!ics) return { statusCode: 404, headers: {}, body: 'not found' };
			return { statusCode: 200, headers: { etag: '"stored-1"' }, body: ics };
		}
		if (o.method === 'PUT' || o.method === 'DELETE') {
			if ((opts.writeFails ?? []).some((c) => String(o.url).startsWith(c))) {
				return { statusCode: 403, headers: {}, body: 'forbidden' };
			}
			return { statusCode: 201, headers: { etag: '"w1"' }, body: '' };
		}
		if (o.method === 'REPORT') {
			if (opts.reportFails?.includes(o.url)) {
				return { statusCode: 403, headers: {}, body: 'forbidden' };
			}
			return {
				statusCode: 207,
				headers: {},
				body: eventsMultistatus(opts.events?.[o.url] ?? []),
			};
		}
		throw new Error(`unexpected ${o.method} ${o.url}`);
	});

	return {
		requests,
		httpRequestWithAuthentication,
		getInputData: () => Array.from({ length: opts.itemCount ?? 1 }, () => ({ json: {} })),
		getNode: () => ({ name: 'CalDAV', type: 'calDav', typeVersion: 1, id: 'n1' }),
		getCredentials: async () => ({ serverUrl: SERVER, username: 'bob', password: 'p' }),
		getNodeParameter: (name: string, _i: number, fallback?: unknown) =>
			name in opts.params ? opts.params[name] : fallback,
		continueOnFail: () => false,
		logger: { debug: vi.fn() },
		helpers: { httpRequestWithAuthentication },
	};
}

async function run(opts: Options) {
	const ctx = makeContext(opts);
	const [items] = await new CalDav().execute.call(ctx as any);
	return { items: items.map((x) => x.json as Record<string, any>), ctx };
}

const base = { resource: 'event', returnAll: true, simplify: true };

describe('Get Many', () => {
	it('returns the events in the window, sorted by start', async () => {
		const { items } = await run({
			params: {
				...base,
				operation: 'getAll',
				calendar: WORK,
				timeMin: '2026-04-01T00:00:00Z',
				timeMax: '2026-05-01T00:00:00Z',
			},
			events: {
				[WORK]: [
					{
						href: '/calendars/bob/work/b.ics',
						ics: calendarData(vevent('b', 'Later', '20260420T120000Z', '20260420T130000Z')),
					},
					{
						href: '/calendars/bob/work/a.ics',
						ics: calendarData(vevent('a', 'Earlier', '20260405T090000Z', '20260405T100000Z')),
					},
				],
			},
		});
		expect(items.map((e) => e.summary)).toEqual(['Earlier', 'Later']);
		expect(items[0].start).toBe('2026-04-05T09:00:00.000Z');
		expect(items[0].calendarUrl).toBe(WORK);
	});

	it('honours the limit when Return All is off', async () => {
		const { items } = await run({
			params: {
				...base,
				operation: 'getAll',
				calendar: WORK,
				returnAll: false,
				limit: 1,
				timeMin: '2026-04-01T00:00:00Z',
				timeMax: '2026-05-01T00:00:00Z',
			},
			events: {
				[WORK]: [
					{
						href: '/calendars/bob/work/a.ics',
						ics: calendarData(
							vevent('a', 'One', '20260405T090000Z', '20260405T100000Z'),
							vevent('b', 'Two', '20260406T090000Z', '20260406T100000Z'),
						),
					},
				],
			},
		});
		expect(items).toHaveLength(1);
		expect(items[0].summary).toBe('One');
	});

	it('omits raw when simplified and keeps it otherwise', async () => {
		const events = {
			[WORK]: [
				{
					href: '/calendars/bob/work/a.ics',
					ics: calendarData(vevent('a', 'One', '20260405T090000Z', '20260405T100000Z')),
				},
			],
		};
		const params = {
			...base,
			operation: 'getAll',
			calendar: WORK,
			timeMin: '2026-04-01T00:00:00Z',
			timeMax: '2026-05-01T00:00:00Z',
		};
		const simplified = await run({ params, events });
		expect(simplified.items[0]).not.toHaveProperty('raw');

		const full = await run({ params: { ...params, simplify: false }, events });
		expect(full.items[0].raw).toContain('BEGIN:VCALENDAR');
	});

	it('rejects an unparseable window instead of querying with a bad date', async () => {
		await expect(
			run({
				params: {
					...base,
					operation: 'getAll',
					calendar: WORK,
					timeMin: 'next tuesday',
					timeMax: '2026-05-01T00:00:00Z',
				},
			}),
		).rejects.toThrow(/Time Min is not a valid date/);
	});
});

describe('Get Next', () => {
	it('expands a series and drops occurrences already past', async () => {
		const past = new Date(Date.now() - 3 * 86400000);
		const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
		const { items } = await run({
			params: { ...base, operation: 'getNext', calendar: WORK, lookaheadDays: 30 },
			events: {
				[WORK]: [
					{
						href: '/calendars/bob/work/series.ics',
						ics: calendarData(
							vevent(
								'series',
								'Daily standup',
								stamp(past),
								stamp(new Date(past.getTime() + 3600000)),
								'RRULE:FREQ=DAILY',
							),
						),
					},
				],
			},
		});
		expect(items.length).toBeGreaterThan(5);
		// Every returned occurrence is in the future, and they are distinct.
		for (const e of items) expect(new Date(e.start).getTime()).toBeGreaterThanOrEqual(Date.now());
		expect(new Set(items.map((e) => e.start)).size).toBe(items.length);
		expect(items.every((e) => e.uid === 'series')).toBe(true);
	});
});

describe('Search', () => {
	it('keeps only events matching the query', async () => {
		const { items } = await run({
			params: {
				...base,
				operation: 'search',
				calendar: WORK,
				query: 'zahnarzt',
				timeMin: '2026-04-01T00:00:00Z',
				timeMax: '2026-05-01T00:00:00Z',
			},
			events: {
				[WORK]: [
					{
						href: '/calendars/bob/work/a.ics',
						ics: calendarData(
							vevent('a', 'Zahnarzt Termin', '20260405T090000Z', '20260405T100000Z'),
							vevent('b', 'Team meeting', '20260406T090000Z', '20260406T100000Z'),
						),
					},
				],
			},
		});
		expect(items.map((e) => e.summary)).toEqual(['Zahnarzt Termin']);
	});
});

describe('All Calendars', () => {
	const allParams = {
		...base,
		operation: 'getAll',
		calendar: '__ALL__',
		timeMin: '2026-04-01T00:00:00Z',
		timeMax: '2026-05-01T00:00:00Z',
	};
	const spread = {
		[WORK]: [
			{
				href: '/calendars/bob/work/w.ics',
				ics: calendarData(vevent('w', 'Work item', '20260410T090000Z', '20260410T100000Z')),
			},
		],
		[HOME]: [
			{
				href: '/calendars/bob/home/h.ics',
				ics: calendarData(vevent('h', 'Home item', '20260405T090000Z', '20260405T100000Z')),
			},
		],
	};

	it('merges and sorts across every calendar', async () => {
		const { items } = await run({ params: allParams, events: spread });
		expect(items.map((e) => e.summary)).toEqual(['Home item', 'Work item']);
		expect(items.map((e) => e.calendarName)).toEqual(['Home', 'Work']);
	});

	it('discovers calendars once per execution, not once per input item', async () => {
		// Discovery is a chain of PROPFINDs. It used to run again for every input
		// item, so a 5-item batch paid for it five times over. The REPORTs still
		// run per item — only the discovery is memoised.
		const { ctx, items } = await run({ params: allParams, events: spread, itemCount: 5 });
		const listings = ctx.requests.filter(
			(r) => r.method === 'PROPFIND' && r.url === 'https://dav.example.com/calendars/bob/',
		);
		expect(listings).toHaveLength(1);
		expect(ctx.requests.filter((r) => r.method === 'REPORT')).toHaveLength(10);
		expect(items).toHaveLength(10);
	});

	it('skips a calendar that rejects REPORT rather than failing the run', async () => {
		const { items } = await run({
			params: allParams,
			events: spread,
			reportFails: [WORK],
		});
		expect(items.map((e) => e.summary)).toEqual(['Home item']);
	});
});

describe('read-only calendars', () => {
	const listCalendars = async (opts: Partial<Options> = {}) => {
		const { items } = await run({
			params: { resource: 'calendar', operation: 'getAll' },
			...opts,
		} as Options);
		return items;
	};

	it('reports readOnly from the server privileges', async () => {
		const items = await listCalendars({ homeWritable: false });
		expect(items.map((c) => [c.displayName, c.readOnly])).toEqual([
			['Work', false],
			['Home', true],
		]);
	});

	it('leaves readOnly undefined when the server reports no privileges', async () => {
		// Absent privileges mean "unknown". Treating that as read-only would
		// mislabel every calendar on servers that do not implement the property.
		const items = await listCalendars({ reportPrivileges: false });
		expect(items.every((c) => c.readOnly === undefined)).toBe(true);
	});

	it('costs no additional request', async () => {
		const ctx = makeContext({ params: { resource: 'calendar', operation: 'getAll' } });
		await new CalDav().execute.call(ctx as any);
		const listings = ctx.requests.filter(
			(r) => r.method === 'PROPFIND' && r.url === 'https://dav.example.com/calendars/bob/',
		);
		expect(listings).toHaveLength(1);
	});

	it('explains a 403 on write instead of passing it through', async () => {
		await expect(
			run({
				params: {
					resource: 'event',
					operation: 'create',
					calendar: HOME,
					summary: 'Nope',
					start: '2026-04-20T10:00:00Z',
					end: '2026-04-20T11:00:00Z',
				},
				writeFails: [HOME],
			}),
		).rejects.toThrow(/403 Forbidden/);
	});
});

describe('recurring-series guard', () => {
	const single = calendarData(vevent('e1', 'One off', '20260420T100000Z', '20260420T110000Z'));
	const series = calendarData(
		vevent(
			'e1',
			'Weekly standup',
			'20260420T100000Z',
			'20260420T103000Z',
			'RRULE:FREQ=WEEKLY;BYDAY=MO',
		),
	);
	const del = (extra: Record<string, unknown> = {}) => ({
		resource: 'event',
		operation: 'delete',
		calendar: WORK,
		uid: 'e1',
		...extra,
	});

	it('deletes a plain event without any confirmation', async () => {
		const { items } = await run({ params: del(), storedEvent: single });
		expect(items[0].deleted).toBe(true);
	});

	it('refuses to delete a series unless it is asked for', async () => {
		// Deleting "tomorrow's standup" by UID removes every occurrence. An
		// agent acting on a user's behalf must not be able to do that silently.
		await expect(run({ params: del(), storedEvent: series })).rejects.toThrow(
			/recurring series.*affect every occurrence/s,
		);
	});

	it('names the rule so the caller can see what is at stake', async () => {
		await expect(run({ params: del(), storedEvent: series })).rejects.toThrow(
			/FREQ=WEEKLY;BYDAY=MO/,
		);
	});

	it('deletes the series once Entire Series is set', async () => {
		const { items, ctx } = await run({
			params: del({ entireSeries: true }),
			storedEvent: series,
		});
		expect(items[0].deleted).toBe(true);
		expect(ctx.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1);
	});

	it('applies the same guard to update', async () => {
		await expect(
			run({
				params: {
					resource: 'event',
					operation: 'update',
					calendar: WORK,
					uid: 'e1',
					summary: 'Renamed',
					start: '2026-04-20T10:00:00Z',
					end: '2026-04-20T11:00:00Z',
				},
				storedEvent: series,
			}),
		).rejects.toThrow(/recurring series.*update/s);
	});

	it('lets update through for a plain event', async () => {
		const { items } = await run({
			params: {
				resource: 'event',
				operation: 'update',
				calendar: WORK,
				uid: 'e1',
				summary: 'Renamed',
				start: '2026-04-20T10:00:00Z',
				end: '2026-04-20T11:00:00Z',
			},
			storedEvent: single,
		});
		expect(items[0].updated).toBe(true);
	});

	it('reports a missing event instead of deleting nothing quietly', async () => {
		await expect(run({ params: del() })).rejects.toThrow(/was not found/);
	});
});

describe('conditional delete', () => {
	const single = calendarData(vevent('e1', 'One off', '20260420T100000Z', '20260420T110000Z'));

	it('sends If-Match with the stored ETag', async () => {
		const ctx = makeContext({
			params: { resource: 'event', operation: 'delete', calendar: WORK, uid: 'e1' },
			storedEvent: single,
		});
		const seen: any[] = [];
		const original = ctx.helpers.httpRequestWithAuthentication;
		ctx.helpers.httpRequestWithAuthentication = (async (cred: string, o: any) => {
			seen.push(o);
			return original(cred, o);
		}) as any;
		await new CalDav().execute.call(ctx as any);
		const del = seen.find((o) => o.method === 'DELETE');
		expect(del.headers['If-Match']).toBe('"stored-1"');
	});
});
