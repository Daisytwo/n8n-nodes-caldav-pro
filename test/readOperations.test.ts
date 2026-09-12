import { describe, expect, it, vi } from 'vitest';
import { CalDav } from '../nodes/CalDav/CalDav.node';

describe('calendar dropdown credentials', () => {
	it.each(['calendar', 'event'])('loads calendars for %s with only CalDAV credentials', async (resource) => {
		const ctx = makeContext({ params: { resource } });
		const originalGetCredentials = ctx.getCredentials;
		const getCredentials = vi.fn(async (name: string) => {
			if (name !== 'calDavApi') throw new Error('ICS credentials must not be read');
			return originalGetCredentials();
		});
		const options = await new CalDav().methods.loadOptions.getCalendars.call({ ...ctx, getCredentials } as any);
		expect(options.map((option) => option.value)).toEqual(['__DEFAULT__', '__ALL__', WORK, HOME]);
		expect(getCredentials).toHaveBeenCalledWith('calDavApi');
	});
});

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
	/** Event resource URLs whose DELETE should return 403 after a successful copy. */
	deleteFails?: string[];
	/** iCalendar returned by GET on a single event resource. */
	storedEvent?: string;
	/** ETag header returned by GET on a single event resource. */
	storedEtag?: string | string[];
	/** The workflow timezone the node reports via getTimezone(). */
	timezone?: string;
}

/**
 * A fake n8n execution context. Discovery is answered by inspecting the
 * PROPFIND body, so the node walks its real request chain.
 */
function makeContext(opts: Options) {
	const requests: Array<{ method: string; url: string; headers?: Record<string, string> }> = [];
	const httpRequestWithAuthentication = vi.fn(async (_cred: string, o: any) => {
		requests.push({ method: o.method, url: o.url, headers: o.headers });
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
			return { statusCode: 200, headers: { etag: opts.storedEtag ?? '"stored-1"' }, body: ics };
		}
		if (o.method === 'PUT' || o.method === 'DELETE') {
			if (o.method === 'DELETE' && (opts.deleteFails ?? []).some((c) => String(o.url).startsWith(c))) {
				return { statusCode: 403, headers: {}, body: 'delete forbidden' };
			}
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
		getTimezone: () => opts.timezone ?? 'Europe/Berlin',
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

	it('keeps today and ongoing multi-day all-day events using exclusive DTEND in the workflow timezone', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-20T22:30:00Z'));
		try {
			const allDay = (uid: string, summary: string, start: string, end: string) =>
				calendarData(
					[
						'BEGIN:VEVENT',
						`UID:${uid}`,
						'DTSTAMP:20260101T000000Z',
						`DTSTART;VALUE=DATE:${start}`,
						`DTEND;VALUE=DATE:${end}`,
						`SUMMARY:${summary}`,
						'END:VEVENT',
					].join('\r\n'),
				);
			const { items } = await run({
				params: { ...base, operation: 'getNext', calendar: WORK, lookaheadDays: 7 },
				timezone: 'Europe/Berlin',
				events: {
					[WORK]: [
						{ href: '/calendars/bob/work/today.ics', ics: allDay('today', 'Today in Berlin', '20260421', '20260422') },
						{ href: '/calendars/bob/work/ongoing.ics', ics: allDay('ongoing', 'Ongoing', '20260419', '20260422') },
						{ href: '/calendars/bob/work/ended.ics', ics: allDay('ended', 'Ended yesterday', '20260419', '20260421') },
					],
				},
			});
			expect(items.map((e) => e.summary)).toEqual(['Ongoing', 'Today in Berlin']);
		} finally {
			vi.useRealTimers();
		}
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

	it('skips every calendar when they all reject, rather than failing', async () => {
		// Fanning out is best-effort by design: a read-only feed or a schedule
		// inbox in the home set must not take the whole run down.
		const { items } = await run({
			params: allParams,
			events: spread,
			reportFails: [WORK, HOME],
		});
		expect(items).toEqual([]);
	});
});

describe('a failing REPORT on the chosen calendar', () => {
	// Swallowing this is right for "All Calendars" and wrong for one calendar:
	// an expired app password or a revoked share would read as "no events",
	// which is the one answer a workflow — or an agent — must never be given.
	const window = { timeMin: '2026-04-01T00:00:00Z', timeMax: '2026-05-01T00:00:00Z' };

	it('fails Get Many instead of reporting an empty calendar', async () => {
		await expect(
			run({
				params: { ...base, operation: 'getAll', calendar: WORK, ...window },
				reportFails: [WORK],
			}),
		).rejects.toThrow(/Forbidden|403/);
	});

	it('fails Search the same way', async () => {
		await expect(
			run({
				params: { ...base, operation: 'search', calendar: WORK, query: 'x', ...window },
				reportFails: [WORK],
			}),
		).rejects.toThrow(/Forbidden|403/);
	});

	it('fails Get Next the same way', async () => {
		await expect(
			run({
				params: { ...base, operation: 'getNext', calendar: WORK, lookaheadDays: 30 },
				reportFails: [WORK],
			}),
		).rejects.toThrow(/Forbidden|403/);
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
		await new CalDav().execute.call(ctx as any);
		const del = ctx.requests.find((o) => o.method === 'DELETE');
		expect(del?.headers?.['If-Match']).toBe('"stored-1"');
	});

	it('omits If-Match for a weak ETag on Delete', async () => {
		const ctx = makeContext({
			params: { resource: 'event', operation: 'delete', calendar: WORK, uid: 'e1' },
			storedEvent: single,
			storedEtag: 'W/"weak-1"',
		});
		await new CalDav().execute.call(ctx as any);
		const del = ctx.requests.find((o) => o.method === 'DELETE');
		expect(del?.headers?.['If-Match']).toBeUndefined();
	});

	it('omits If-Match for a weak ETag on Update', async () => {
		const ctx = makeContext({
			params: {
				resource: 'event',
				operation: 'update',
				calendar: WORK,
				uid: 'e1',
				summary: 'Renamed',
				start: '',
				end: '',
			},
			storedEvent: single,
			storedEtag: ['W/"weak-1"'],
		});
		await new CalDav().execute.call(ctx as any);
		const put = ctx.requests.find((o) => o.method === 'PUT');
		expect(put?.headers?.['If-Match']).toBeUndefined();
	});
});

describe('Move', () => {
	const single = calendarData(vevent('e1', 'One off', '20260420T100000Z', '20260420T110000Z'));
	const moveParams = { resource: 'event', operation: 'move', calendar: WORK, uid: 'e1', targetCalendar: HOME };

	it('copies to the target and deletes the source on success', async () => {
		const { items, ctx } = await run({ params: moveParams, storedEvent: single });
		expect(items[0]).toMatchObject({ moved: true, oldUrl: `${WORK}e1.ics`, newUrl: `${HOME}e1.ics` });
		expect(ctx.requests.some((r) => r.method === 'PUT' && r.url === `${HOME}e1.ics`)).toBe(true);
		expect(ctx.requests.some((r) => r.method === 'DELETE' && r.url === `${WORK}e1.ics`)).toBe(true);
	});

	it('omits If-Match for a weak ETag on Move source DELETE', async () => {
		const ctx = makeContext({ params: moveParams, storedEvent: single, storedEtag: 'W/"weak-1"' });
		await new CalDav().execute.call(ctx as any);
		const del = ctx.requests.find((o) => o.method === 'DELETE');
		expect(del?.headers?.['If-Match']).toBeUndefined();
	});

	it('explains when the target copy exists but deleting the source failed', async () => {
		await expect(
			run({ params: moveParams, storedEvent: single, deleteFails: [WORK] }),
		).rejects.toThrow(/Target copy exists.*source still exists.*Manual cleanup/is);
	});
});

describe('time window validation', () => {
	const window = (timeMin: unknown, timeMax: unknown) =>
		run({
			params: { ...base, operation: 'getAll', calendar: WORK, timeMin, timeMax },
		});

	it('rejects a reversed window', async () => {
		await expect(window('2026-05-01T00:00:00Z', '2026-04-01T00:00:00Z')).rejects.toThrow(
			/Time Max must be after Time Min/,
		);
	});

	it('rejects a zero-width window', async () => {
		// The server answers this with an empty result, which reads as
		// "no events" rather than as the mistake it is.
		await expect(window('2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z')).rejects.toThrow(
			/Time Max must be after Time Min/,
		);
	});

	it('names the offending field for an unparseable bound', async () => {
		await expect(window('next tuesday', '2026-05-01T00:00:00Z')).rejects.toThrow(
			/Time Min is not a valid date/,
		);
		await expect(window('2026-04-01T00:00:00Z', 'whenever')).rejects.toThrow(
			/Time Max is not a valid date/,
		);
	});

	it('accepts a normal window', async () => {
		const { items } = await window('2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z');
		expect(items).toEqual([]);
	});

	it('rejects a non-positive lookahead', async () => {
		// typeOptions.minValue constrains the UI, not an expression.
		for (const days of [0, -7]) {
			await expect(
				run({ params: { ...base, operation: 'getNext', calendar: WORK, lookaheadDays: days } }),
			).rejects.toThrow(/Lookahead Days must be a positive number/);
		}
	});

	it('accepts a positive lookahead', async () => {
		const { items } = await run({
			params: { ...base, operation: 'getNext', calendar: WORK, lookaheadDays: 7 },
		});
		expect(items).toEqual([]);
	});
});

describe('local time through the node', () => {
	const utcEvent = {
		[WORK]: [
			{
				href: '/calendars/bob/work/a.ics',
				ics: calendarData(vevent('a', 'Standup', '20260728T190000Z', '20260728T193000Z')),
			},
		],
	};
	const params = {
		...base,
		operation: 'getAll',
		calendar: WORK,
		timeMin: '2026-07-01T00:00:00Z',
		timeMax: '2026-08-01T00:00:00Z',
	};

	it('renders a UTC event in the workflow timezone', async () => {
		const { items } = await run({ params, events: utcEvent, timezone: 'Europe/Berlin' });
		expect(items[0].start).toBe('2026-07-28T19:00:00.000Z');
		expect(items[0].startLocal).toBe('2026-07-28T21:00:00+02:00');
	});

	it('follows the workflow timezone wherever it points', async () => {
		const { items } = await run({ params, events: utcEvent, timezone: 'Asia/Tokyo' });
		expect(items[0].startLocal).toBe('2026-07-29T04:00:00+09:00');
	});

	it('keeps startLocal when simplified', async () => {
		const { items } = await run({ params, events: utcEvent, timezone: 'Europe/Berlin' });
		expect(items[0]).not.toHaveProperty('raw');
		expect(items[0].startLocal).toBeDefined();
		expect(items[0].endLocal).toBeDefined();
	});
});

describe('single occurrence through the node', () => {
	const series = calendarData(
		vevent(
			'jf',
			'Jour fixe',
			'20260406T100000Z',
			'20260406T110000Z',
			'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4',
		),
	);
	const secondSlot = '2026-04-13T10:00:00.000Z';

	it('cancels one date with a PUT, not a DELETE', async () => {
		// The whole series lives in one resource; deleting the resource would
		// take every occurrence with it.
		const { items, ctx } = await run({
			params: {
				resource: 'event',
				operation: 'delete',
				calendar: WORK,
				uid: 'jf',
				recurrenceId: secondSlot,
			},
			storedEvent: series,
		});
		expect(ctx.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
		expect(ctx.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
		expect(items[0].deleted).toBe(true);
		expect(items[0].recurrenceId).toBe(secondSlot);
	});

	it('sends the series back with that date excluded', async () => {
		const seen: any[] = [];
		const ctx = makeContext({
			params: {
				resource: 'event',
				operation: 'delete',
				calendar: WORK,
				uid: 'jf',
				recurrenceId: secondSlot,
			},
			storedEvent: series,
		});
		const original = ctx.helpers.httpRequestWithAuthentication;
		ctx.helpers.httpRequestWithAuthentication = (async (cred: string, o: any) => {
			seen.push(o);
			return original(cred, o);
		}) as any;
		await new CalDav().execute.call(ctx as any);
		const put = seen.find((o) => o.method === 'PUT');
		expect(put.body).toContain('EXDATE');
		expect(put.headers['If-Match']).toBe('"stored-1"');
	});

	it('does not need Entire Series when an occurrence is named', async () => {
		await expect(
			run({
				params: {
					resource: 'event',
					operation: 'update',
					calendar: WORK,
					uid: 'jf',
					recurrenceId: secondSlot,
					summary: 'Moved',
					start: '2026-04-13T14:00:00Z',
					end: '2026-04-13T15:00:00Z',
				},
				storedEvent: series,
			}),
		).resolves.toBeDefined();
	});

	it('still demands a decision when neither is given', async () => {
		await expect(
			run({
				params: { resource: 'event', operation: 'delete', calendar: WORK, uid: 'jf' },
				storedEvent: series,
			}),
		).rejects.toThrow(/recurring series/);
	});

	it('reports an occurrence that does not exist', async () => {
		await expect(
			run({
				params: {
					resource: 'event',
					operation: 'delete',
					calendar: WORK,
					uid: 'jf',
					recurrenceId: '2026-04-14T10:00:00.000Z',
				},
				storedEvent: series,
			}),
		).rejects.toThrow(/No occurrence of this series starts at/);
	});
});

describe('Update is a patch, not a rewrite', () => {
	const stored = calendarData(
		vevent(
			'e1',
			'Original title',
			'20260420T100000Z',
			'20260420T110000Z',
			'LOCATION:Room 3',
			'DESCRIPTION:Agenda from the organiser',
		),
	);

	/** Run an update and hand back the body of the PUT it sent. */
	async function putBodyFor(params: Record<string, unknown>) {
		const ctx = makeContext({
			params: { resource: 'event', operation: 'update', calendar: WORK, uid: 'e1', ...params },
			storedEvent: stored,
		});
		const seen: any[] = [];
		const original = ctx.helpers.httpRequestWithAuthentication;
		ctx.helpers.httpRequestWithAuthentication = (async (cred: string, o: any) => {
			seen.push(o);
			return original(cred, o);
		}) as any;
		await new CalDav().execute.call(ctx as any);
		return String(seen.find((o) => o.method === 'PUT').body);
	}

	it('leaves the stored times alone when only the summary is given', async () => {
		// The regression this guards: Start and End used to be required fields
		// defaulting to "$now", so renaming an event moved it to the current
		// time — silently, and reported as a success.
		const body = await putBodyFor({ summary: 'Renamed', start: '', end: '' });
		expect(body).toContain('SUMMARY:Renamed');
		expect(body).toContain('DTSTART:20260420T100000Z');
		expect(body).toContain('DTEND:20260420T110000Z');
	});

	it('leaves the stored summary alone when only the times are given', async () => {
		const body = await putBodyFor({
			summary: '',
			start: '2026-04-21T10:00:00Z',
			end: '2026-04-21T11:00:00Z',
		});
		expect(body).toContain('SUMMARY:Original title');
		expect(body).toContain('DTSTART:20260421T100000Z');
	});

	it('keeps every field the caller did not mention', async () => {
		const body = await putBodyFor({ summary: 'Renamed', start: '', end: '' });
		expect(body).toContain('LOCATION:Room 3');
		expect(body).toContain('DESCRIPTION:Agenda from the organiser');
	});

	it('still refuses a half-specified range', async () => {
		await expect(putBodyFor({ start: '2026-04-21T10:00:00Z', end: '' })).rejects.toThrow(
			/Start and End must be updated together/,
		);
		await expect(putBodyFor({ start: '', end: '2026-04-21T11:00:00Z' })).rejects.toThrow(
			/Start and End must be updated together/,
		);
	});

	it('rejects a timed update whose End is not after Start', async () => {
		await expect(
			putBodyFor({
				summary: '',
				start: '2026-04-21T10:00:00Z',
				end: '2026-04-21T10:00:00Z',
			}),
		).rejects.toThrow(/End must be after Start/);
	});

	it('reports back only what it actually changed', async () => {
		const { items } = await run({
			params: {
				resource: 'event',
				operation: 'update',
				calendar: WORK,
				uid: 'e1',
				summary: 'Renamed',
				start: '',
				end: '',
			},
			storedEvent: stored,
		});
		expect(items[0].summary).toBe('Renamed');
		expect(items[0].start).toBeUndefined();
		expect(items[0].end).toBeUndefined();
		expect(items[0].updated).toBe(true);
	});
});

describe('Create still insists on the fields it needs', () => {
	const create = (extra: Record<string, unknown>) =>
		run({ params: { resource: 'event', operation: 'create', calendar: WORK, ...extra } });

	it('names the missing field instead of failing on a NaN date', async () => {
		await expect(create({ summary: 'x', start: '', end: '2026-04-20T11:00:00Z' })).rejects.toThrow(
			/Start is required/,
		);
		await expect(create({ summary: 'x', start: '2026-04-20T10:00:00Z', end: '' })).rejects.toThrow(
			/End is required/,
		);
		await expect(
			create({ summary: '', start: '2026-04-20T10:00:00Z', end: '2026-04-20T11:00:00Z' }),
		).rejects.toThrow(/Summary is required/);
	});

	it('creates the event once all three are there', async () => {
		const { items } = await create({
			summary: 'Team meeting',
			start: '2026-04-20T10:00:00Z',
			end: '2026-04-20T11:00:00Z',
		});
		expect(items[0].uid).toBeDefined();
		expect(items[0].summary).toBe('Team meeting');
	});

	it('rejects a timed event whose End is not after Start', async () => {
		await expect(
			create({ summary: 'Bad range', start: '2026-04-20T10:00:00Z', end: '2026-04-20T10:00:00Z' }),
		).rejects.toThrow(/End must be after Start/);
	});
});

describe('parameter defaults', () => {
	const props = new CalDav().description.properties;
	const forOperation = (name: string, operation: string) =>
		props.filter(
			(p) =>
				p.name === name &&
				((p.displayOptions?.show?.operation as string[] | undefined) ?? []).includes(operation),
		);

	it('gives Update no default that would move or rename the event', () => {
		// A "$now" default here is what made a title-only update reschedule the
		// event; an empty default is what makes "not mentioned" expressible.
		for (const name of ['summary', 'start', 'end']) {
			const [prop] = forOperation(name, 'update');
			expect(prop, `${name} for update`).toBeDefined();
			expect(prop.default, `${name} default for update`).toBe('');
			expect(prop.required ?? false, `${name} required for update`).toBe(false);
		}
	});

	it('keeps Create required, with the defaults that make it convenient', () => {
		for (const name of ['summary', 'start', 'end']) {
			const [prop] = forOperation(name, 'create');
			expect(prop, `${name} for create`).toBeDefined();
			expect(prop.required, `${name} required for create`).toBe(true);
		}
		expect(String(forOperation('start', 'create')[0].default)).toContain('$now');
		expect(String(forOperation('end', 'create')[0].default)).toContain('$now');
	});
});
