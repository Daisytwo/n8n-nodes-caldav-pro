import type {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IDataObject,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { randomUUID } from 'crypto';

import {
	absoluteUrl,
	davRequest,
	discoverCalendars,
	buildICalEvent,
	patchICalEvent,
	patchOccurrence,
	removeOccurrence,
	buildTimeRangeReport,
	parseCalendarQueryResponse,
	parseICalEvent,
	resolveDefaultCalendar,
	resolveEventUrl,
	seriesRecurrenceRule,
	simplifyEvent,
	eventMatchesText,
	etagValue,
	ifMatchHeader,
	localDateString,
	type CalDavEvent,
} from './GenericFunctions';
import {
	assertSafeFeedUrl,
	expandIcsFeed,
	fetchIcsFeed,
	toFeedEvent,
} from './IcsFeedFunctions';
import { calendarOperations, calendarFields } from './CalendarDescription';
import { eventOperations, eventFields } from './EventDescription';
import { icsFeedOperations, icsFeedFields } from './IcsFeedDescription';

/** Optional editor credentials still have to be configured for the active resource. */
async function requireResourceCredentials(
	this: IExecuteFunctions | ILoadOptionsFunctions,
	name: 'calDavApi' | 'icsFeedApi',
): Promise<IDataObject> {
	const credentials = await this.getCredentials(name);
	const fields = name === 'calDavApi' ? ['serverUrl', 'username', 'password'] : ['feedUrl'];
	if (fields.some((field) => typeof credentials?.[field] !== 'string' || !credentials[field])) {
		const label = name === 'calDavApi' ? 'CalDAV API' : 'ICS Feed API';
		throw new NodeOperationError(
			this.getNode(),
			`${label} credential is required. Select and configure it for this resource.`,
		);
	}
	return credentials;
}

/**
 * Explain a 403 from a write instead of passing "Forbidden" through.
 *
 * The usual cause is a read-only calendar — one shared with you, or a
 * subscribed feed such as a holiday calendar. Servers say nothing beyond the
 * status code, and such calendars are indistinguishable from writable ones
 * once a URL has been copied into an expression.
 */
function rethrowWriteError(
	this: IExecuteFunctions,
	error: unknown,
	itemIndex: number,
	calendarUrl: string,
): never {
	if ((error as { httpCode?: string }).httpCode === '403') {
		throw new NodeOperationError(
			this.getNode(),
			`The calendar rejected the write (403 Forbidden): ${calendarUrl}`,
			{
				itemIndex,
				description:
					'This is usually a read-only calendar — one shared with you, or a subscribed feed. Read-only calendars are marked 🔒 in the Calendar dropdown, and Calendar > Get Many reports "readOnly": true for them. Pick a calendar you own.',
			},
		);
	}
	throw error;
}

/**
 * Refuse a write that would silently hit an entire recurring series.
 *
 * Every occurrence shares one UID and one resource, so deleting "tomorrow's
 * standup" by UID removes the whole series. That is rarely what the caller
 * meant, and when an AI Agent drives the node it is not what the *user* meant
 * either — so it has to be asked for explicitly.
 */
function guardRecurringSeries(
	this: IExecuteFunctions,
	raw: string,
	itemIndex: number,
	verb: 'delete' | 'update',
) {
	const rule = seriesRecurrenceRule(raw);
	if (!rule) return;
	if (this.getNodeParameter('entireSeries', itemIndex, false) as boolean) return;
	throw new NodeOperationError(
		this.getNode(),
		`This event is a recurring series (${rule}), so the ${verb} would affect every occurrence.`,
		{
			itemIndex,
			description:
				'Set "Occurrence" to a recurrenceId from a read operation to act on that one date only, or turn on "Entire Series" to affect all of them.',
		},
	);
}

/**
 * Origin-check a URL the caller supplied, naming the field it came from.
 *
 * "Calendar" and "Target Calendar" are options parameters, but an expression —
 * or an AI Agent filling the tool schema — can put any string in them, and the
 * credential's Basic auth rides along on whatever we then request. Checking
 * here keeps that decision ahead of the first authenticated request.
 */
function checkedUrl(
	this: IExecuteFunctions,
	url: string,
	serverUrl: string,
	field: string,
	itemIndex: number,
): string {
	try {
		return absoluteUrl(url, serverUrl, field);
	} catch (error) {
		throw new NodeOperationError(this.getNode(), (error as Error).message, { itemIndex });
	}
}

/**
 * Work out which resource an operation should act on, from whichever of
 * Event URL / Event UID the caller supplied.
 */
async function locateEvent(
	this: IExecuteFunctions,
	itemIndex: number,
	calendarUrl: string,
	serverUrl: string,
): Promise<{ uid: string; eventUrl: string }> {
	const uid = (this.getNodeParameter('uid', itemIndex, '') as string).trim();
	const explicitUrl = (this.getNodeParameter('eventUrl', itemIndex, '') as string).trim();
	if (!uid && !explicitUrl) {
		throw new NodeOperationError(
			this.getNode(),
			'Either Event UID or Event URL is required to identify the event.',
			{
				itemIndex,
				description:
					'Read operations return both — pass the "url" field through for the most reliable result.',
			},
		);
	}
	// An explicit Event URL is origin-checked inside resolveEventUrl, before it
	// makes any request; surface that as a node error against this item.
	let eventUrl: string;
	try {
		eventUrl = await resolveEventUrl.call(this, calendarUrl, uid, explicitUrl, serverUrl);
	} catch (error) {
		if (error instanceof NodeOperationError || error instanceof NodeApiError) throw error;
		throw new NodeOperationError(this.getNode(), (error as Error).message, { itemIndex });
	}
	return { uid, eventUrl };
}

/**
 * Read one end of a time window, rejecting garbage with a message that names
 * the field. Without this an unparseable date reaches the REPORT body as
 * "NaNNaNNaN" and comes back as an opaque 400 from the server.
 */
function readWindowBound(
	this: IExecuteFunctions,
	itemIndex: number,
	parameter: string,
	label: string,
): Date {
	const raw = this.getNodeParameter(parameter, itemIndex) as string;
	const parsed = new Date(raw);
	if (Number.isNaN(parsed.getTime())) {
		throw new NodeOperationError(this.getNode(), `${label} is not a valid date: "${raw}"`, {
			itemIndex,
			description: 'Expected ISO 8601, for example "2026-04-20T00:00:00+02:00".',
		});
	}
	return parsed;
}

/**
 * The window a read operation asks for, plus the predicate applied on top of it.
 *
 * Get Many, Get Next and Search differ only in those two things, and they differ
 * in exactly the same way whether the events come from a CalDAV server or from a
 * subscribed feed — so both resources read their window here.
 */
function readWindow(
	this: IExecuteFunctions,
	itemIndex: number,
	operation: string,
): { rangeStart: Date; rangeEnd: Date; accept?: (event: CalDavEvent) => boolean } {
	if (operation === 'getNext') {
		const lookaheadDays = this.getNodeParameter('lookaheadDays', itemIndex, 30) as number;
		if (!Number.isFinite(lookaheadDays) || lookaheadDays <= 0) {
			throw new NodeOperationError(
				this.getNode(),
				`Lookahead Days must be a positive number, got ${lookaheadDays}.`,
				{
					itemIndex,
					// The minValue in the UI does not constrain expressions.
					description: 'A zero or negative window can never contain an event.',
				},
			);
		}
		const rangeStart = new Date();
		const rangeEnd = new Date(rangeStart.getTime() + lookaheadDays * 24 * 60 * 60 * 1000);
		// A series can start before "now" and still have an occurrence inside the
		// window; only drop the ones already past.
		const today = localDateString(rangeStart, this.getTimezone());
		return {
			rangeStart,
			rangeEnd,
			accept: (event) => {
				if (!event.start) return true;
				if (event.allDay) return event.end ? event.end > today : event.start >= today;
				return new Date(event.start) >= rangeStart;
			},
		};
	}

	const rangeStart = readWindowBound.call(this, itemIndex, 'timeMin', 'Time Min');
	const rangeEnd = readWindowBound.call(this, itemIndex, 'timeMax', 'Time Max');
	// An inverted or empty window is silently answered with an empty result by
	// the server, which reads as "no events" rather than as the mistake it is.
	if (rangeEnd.getTime() <= rangeStart.getTime()) {
		throw new NodeOperationError(
			this.getNode(),
			`Time Max must be after Time Min (got ${rangeStart.toISOString()} to ${rangeEnd.toISOString()}).`,
			{
				itemIndex,
				description:
					'The window is empty or reversed, so it can never match an event. Check the order of the two fields.',
			},
		);
	}
	if (operation === 'search') {
		const query = this.getNodeParameter('query', itemIndex) as string;
		return { rangeStart, rangeEnd, accept: (event) => eventMatchesText(event, query) };
	}
	return { rangeStart, rangeEnd };
}

/**
 * Run a time-range REPORT across one or every calendar and return the matching
 * events, sorted by start.
 *
 * Shared by Get Many, Get Next, and Search — they differ only in the window and
 * the `accept` predicate.
 */
async function collectEvents(
	this: IExecuteFunctions,
	opts: {
		calendarUrl: string;
		serverUrl: string;
		username: string;
		rangeStart: Date;
		rangeEnd: Date;
		simplify: boolean;
		accept?: (event: CalDavEvent) => boolean;
	},
): Promise<IDataObject[]> {
	const { calendarUrl, serverUrl, username, rangeStart, rangeEnd, simplify, accept } = opts;

	// Either the picked calendar, or every visible one for "All Calendars".
	const fanOut = calendarUrl === '__ALL__';
	const targets = fanOut
		? (await discoverCalendars.call(this, serverUrl, username)).map((c) => ({
				url: c.url.endsWith('/') ? c.url : `${c.url}/`,
				displayName: c.displayName,
			}))
		: [{ url: calendarUrl, displayName: '' }];

	// Events stored in plain UTC carry no zone of their own; the workflow's
	// timezone is the closest thing to the reader's for rendering *Local.
	const localZone = this.getTimezone();
	const body = buildTimeRangeReport(rangeStart.toISOString(), rangeEnd.toISOString());
	const collected: IDataObject[] = [];
	for (const target of targets) {
		try {
			const resp = await davRequest.call(this, 'REPORT', target.url, body, {
				Depth: '1',
				'Content-Type': 'application/xml; charset=utf-8',
			});
			const events = parseCalendarQueryResponse(
				resp.body,
				target.url,
				serverUrl,
				rangeStart,
				rangeEnd,
				localZone,
			);
			for (const event of events) {
				if (accept && !accept(event)) continue;
				collected.push({
					...((simplify ? simplifyEvent(event) : event) as unknown as IDataObject),
					calendarUrl: target.url,
					calendarName: target.displayName || undefined,
				});
			}
		} catch (err) {
			// Skip calendars that reject REPORT (read-only feeds, schedule inbox);
			// one bad collection shouldn't fail a cross-calendar read.
			//
			// Only when we are fanning out, though. On the one calendar the caller
			// picked, swallowing the error turns an expired app password or a
			// revoked share into "no events" — the one answer a workflow, or an
			// agent speaking for the user, must never be given.
			if (!fanOut) throw err;
			this.logger?.debug(`[CalDAV] REPORT skipped for ${target.url}: ${(err as Error).message}`);
		}
	}

	// Deterministic order by start time when reading across calendars.
	collected.sort((a, b) => String(a.start ?? '').localeCompare(String(b.start ?? '')));
	return collected;
}

export class CalDav implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'CalDAV',
		name: 'calDav',
		icon: 'file:calDav.svg',
		group: ['input'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Read and write calendar events over CalDAV (Infomaniak, NextCloud, iCloud, Fastmail, Synology). Works as an AI Agent tool. Returned events carry two forms of each time: "startLocal"/"endLocal" are the event\'s own local time with its UTC offset already applied — use these to tell someone when an event is. "start"/"end" are UTC instants for sorting and arithmetic; do not convert them by hand.',
		defaults: {
			name: 'CalDAV',
		},
		usableAsTool: true,
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			// Keep credential selection independent of resource in the editor's setup
			// view. The active resource requires its own credential at runtime.
			{
				name: 'calDavApi',
				required: false,
			},
			{
				name: 'icsFeedApi',
				required: false,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Calendar', value: 'calendar' },
					{ name: 'Event', value: 'event' },
					{ name: 'ICS Feed (Read-Only)', value: 'icsFeed' },
				],
				default: 'event',
			},
			...calendarOperations,
			...calendarFields,
			...eventOperations,
			...eventFields,
			...icsFeedOperations,
			...icsFeedFields,
		],
	};

	methods = {
		loadOptions: {
			async getCalendars(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				// A stale dropdown request must not access CalDAV credentials for a feed.
				if (this.getNodeParameter('resource') === 'icsFeed') return [];
				const creds = await requireResourceCredentials.call(this, 'calDavApi');
				const serverUrl = creds.serverUrl as string;
				const username = creds.username as string;
				const calendars = await discoverCalendars.call(this, serverUrl, username);
				if (!calendars.length) {
					return [
						{
							name: 'No Calendars Found — Check Server URL and Username',
							value: '',
						},
					];
				}
				// Pseudo-entries:
				//   __DEFAULT__: resolve to the credential's "Default Calendar"
				//                hint at execute time. Valid for every operation.
				//   __ALL__:     iterate over every visible calendar. Valid only
				//                for Get Many / Get Next / Search.
				return [
					{
						name: '🏠 Default Calendar (From Credentials)',
						value: '__DEFAULT__',
					},
					{
						name: '⭐ All Calendars (Search Across)',
						value: '__ALL__',
					},
					// Writable calendars first, and read-only ones marked: a shared
					// calendar or a subscribed feed looks identical otherwise, and
					// writing to one fails with a bare 403.
					...[...calendars]
						.sort((a, b) => Number(a.readOnly ?? false) - Number(b.readOnly ?? false))
						.map((c) => ({
							name: c.readOnly ? `🔒 ${c.displayName} (Read-Only)` : c.displayName,
							value: c.url,
						})),
				];
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;
		// The feed resource must not touch the CalDAV credential at all — not even
		// to read it. Asking for it here would make the node unusable with only a
		// feed configured, and would put an account's password one mistake away
		// from a request aimed at an external host.
		const creds: IDataObject =
			resource === 'icsFeed' ? {} : await requireResourceCredentials.call(this, 'calDavApi');
		// Unlike node parameters, credentials do not vary per input item. Read the
		// secret once so multiple input items still issue only one credential lookup.
		const feedCreds =
			resource === 'icsFeed'
				? ((await requireResourceCredentials.call(this, 'icsFeedApi')) as {
						feedUrl?: string;
						feedName?: string;
					})
				: undefined;
		const serverUrl = creds.serverUrl as string;
		const username = creds.username as string;

		for (let i = 0; i < items.length; i++) {
			try {
				if (resource === 'calendar') {
					if (operation === 'getAll') {
						const calendars = await discoverCalendars.call(this, serverUrl, username);
						for (const cal of calendars) {
							returnData.push({ json: cal as unknown as IDataObject, pairedItem: { item: i } });
						}
					} else {
						throw new NodeOperationError(
							this.getNode(),
							`Unknown calendar operation: ${operation}`,
						);
					}
				} else if (resource === 'event') {
					const calendarUrl = this.getNodeParameter('calendar', i) as string;
					if (!calendarUrl) {
						throw new NodeOperationError(
							this.getNode(),
							'Calendar is required. Pick one from the dropdown.',
							{ itemIndex: i },
						);
					}
					// "All Calendars" is only valid for the multi-calendar reads.
					const allOpsAllowed = ['getAll', 'getNext', 'search'];
					if (calendarUrl === '__ALL__' && !allOpsAllowed.includes(operation)) {
						throw new NodeOperationError(
							this.getNode(),
							`"All Calendars" can only be used with Get Many / Get Next / Search. Pick a specific calendar for "${operation}".`,
							{ itemIndex: i },
						);
					}
					// Resolve "Default Calendar" from credentials at execute time.
					let resolvedUrl = calendarUrl;
					if (calendarUrl === '__DEFAULT__') {
						try {
							resolvedUrl = await resolveDefaultCalendar.call(this, serverUrl, username);
						} catch (e) {
							throw new NodeOperationError(this.getNode(), (e as Error).message, {
								itemIndex: i,
							});
						}
					}
					const calUrlNormalised =
						resolvedUrl === '__ALL__'
							? '__ALL__'
							: checkedUrl.call(
									this,
									resolvedUrl.endsWith('/') ? resolvedUrl : `${resolvedUrl}/`,
									serverUrl,
									'Calendar',
									i,
								);

					if (operation === 'create') {
						const summary = String(this.getNodeParameter('summary', i, '') ?? '');
						const start = String(this.getNodeParameter('start', i, '') ?? '').trim();
						const end = String(this.getNodeParameter('end', i, '') ?? '').trim();
						// `required` constrains the editor, not an expression and not an
						// AI Agent filling the tool schema. Without this the empty value
						// surfaces as "Invalid ISO 8601 date in Start: ", which names the
						// symptom rather than the missing field.
						for (const [label, value] of [
							['Summary', summary.trim()],
							['Start', start],
							['End', end],
						] as const) {
							if (!value) {
								throw new NodeOperationError(
									this.getNode(),
									`${label} is required to create an event.`,
									{ itemIndex: i },
								);
							}
						}
						const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
						const attendeesRaw = (additional.attendees as IDataObject)?.attendee as
							| Array<{ email: string; name?: string }>
							| undefined;
						const remindersRaw = (additional.reminders as IDataObject)?.reminder as
							| Array<{ minutesBefore: number; action?: 'DISPLAY' | 'EMAIL' }>
							| undefined;
						const uid = (additional.uid as string) || randomUUID();
						let iCal: string;
						try {
							iCal = buildICalEvent({
								uid,
								summary,
								start,
								end,
								description: additional.description as string | undefined,
								location: additional.location as string | undefined,
								allDay: additional.allDay as boolean | undefined,
								timezone: additional.timezone as string | undefined,
								rrule: additional.rrule as string | undefined,
								attendees: attendeesRaw,
								reminders: remindersRaw,
							});
						} catch (err) {
							throw new NodeOperationError(this.getNode(), (err as Error).message, { itemIndex: i });
						}
						const eventUrl = `${calUrlNormalised}${encodeURIComponent(uid)}.ics`;
						const resp = await davRequest
							.call(this, 'PUT', eventUrl, iCal, {
								'Content-Type': 'text/calendar; charset=utf-8',
								'If-None-Match': '*',
							})
							.catch((err) => rethrowWriteError.call(this, err, i, calUrlNormalised));
						const etag = etagValue(resp.headers.etag);
						returnData.push({
							json: { uid, url: eventUrl, etag, summary, start, end },
							pairedItem: { item: i },
						});
					} else if (operation === 'get') {
						const { uid, eventUrl } = await locateEvent.call(this, i, calUrlNormalised, serverUrl);
						const simplify = this.getNodeParameter('simplify', i, true) as boolean;
						const resp = await davRequest.call(this, 'GET', eventUrl, undefined, {
							Accept: 'text/calendar',
						});
						const parsed = parseICalEvent(
							resp.body,
							eventUrl,
							etagValue(resp.headers.etag),
							this.getTimezone(),
						);
						if (!parsed) {
							throw new NodeApiError(
								this.getNode(),
								{ message: `Event ${uid} not parseable`, description: resp.body } as unknown as JsonObject,
							);
						}
						const record = simplify ? simplifyEvent(parsed) : parsed;
						returnData.push({ json: record as unknown as IDataObject, pairedItem: { item: i } });
					} else if (operation === 'getAll' || operation === 'getNext' || operation === 'search') {
						// The three reads differ only in the window they ask for and the
						// predicate they apply; everything else is shared.
						const returnAll = this.getNodeParameter('returnAll', i) as boolean;
						const limit = returnAll ? Infinity : (this.getNodeParameter('limit', i) as number);
						const simplify = this.getNodeParameter('simplify', i, true) as boolean;
						const { rangeStart, rangeEnd, accept } = readWindow.call(this, i, operation);

						const collected = await collectEvents.call(this, {
							calendarUrl: calUrlNormalised,
							serverUrl,
							username,
							rangeStart,
							rangeEnd,
							simplify,
							accept,
						});
						for (const ev of collected.slice(0, limit)) {
							returnData.push({ json: ev, pairedItem: { item: i } });
						}
					} else if (operation === 'move') {
						const targetCalendarRaw = this.getNodeParameter('targetCalendar', i) as string;
						if (!targetCalendarRaw) {
							throw new NodeOperationError(this.getNode(), 'Target Calendar is required for the Move operation.', { itemIndex: i });
						}
						if (targetCalendarRaw === '__ALL__') {
							throw new NodeOperationError(this.getNode(), '"All Calendars" is not a valid target for Move. Pick a specific destination.', { itemIndex: i });
						}
						// Both ends are checked before the event is even located, so a
						// foreign destination cannot be reached by any request at all.
						const targetUrl =
							targetCalendarRaw === '__DEFAULT__'
								? await resolveDefaultCalendar.call(this, serverUrl, username)
								: checkedUrl.call(
										this,
										targetCalendarRaw.endsWith('/') ? targetCalendarRaw : `${targetCalendarRaw}/`,
										serverUrl,
										'Target Calendar',
										i,
									);
						const located = await locateEvent.call(this, i, calUrlNormalised, serverUrl);
						if (targetUrl === calUrlNormalised) {
							throw new NodeOperationError(this.getNode(), 'Source and target calendars are identical — nothing to move.', { itemIndex: i });
						}
						const sourceEventUrl = located.eventUrl;
						const getResp = await davRequest.call(this, 'GET', sourceEventUrl, undefined, { Accept: 'text/calendar' });
						const sourceIfMatch = ifMatchHeader(getResp.headers.etag);
						// The destination filename is derived from the UID. When the event
						// was addressed by URL we don't have one yet, so read it back out
						// of the resource we just fetched.
						const uid =
							located.uid || parseICalEvent(getResp.body, sourceEventUrl)?.uid || randomUUID();
						const targetEventUrl = `${targetUrl}${encodeURIComponent(uid)}.ics`;
						// If this throws, the source is left untouched — a move must never
						// destroy the original when the copy did not land.
						const putResp = await davRequest
							.call(this, 'PUT', targetEventUrl, getResp.body, {
								'Content-Type': 'text/calendar; charset=utf-8',
								'If-None-Match': '*',
							})
							.catch((err) => rethrowWriteError.call(this, err, i, targetUrl));
						const newEtag = etagValue(putResp.headers.etag);
						try {
							await davRequest.call(
								this,
								'DELETE',
								sourceEventUrl,
								undefined,
								sourceIfMatch ? { 'If-Match': sourceIfMatch } : undefined,
							);
						} catch (err) {
							throw new NodeOperationError(
								this.getNode(),
								`Move copied the event to the target calendar, but deleting the source failed. Target copy exists at ${targetEventUrl}; source still exists at ${sourceEventUrl}. Manual cleanup may be required.`,
								{
									itemIndex: i,
									description: `Manual cleanup may be required: remove either the copied target (${targetEventUrl}) or the remaining source (${sourceEventUrl}) after checking which one you want to keep. Original delete error: ${(err as Error).message}`,
								},
							);
						}
						returnData.push({
							json: { uid, oldUrl: sourceEventUrl, newUrl: targetEventUrl, etag: newEtag, moved: true },
							pairedItem: { item: i },
						});
					} else if (operation === 'update') {
						const located = await locateEvent.call(this, i, calUrlNormalised, serverUrl);
						const uid = located.uid;
						// Update is a patch: an empty field means "leave what the server
						// has", never "clear it". Anything the caller did not fill in has
						// to reach patchICalEvent as undefined, or a title-only update
						// would reschedule the event and blank its summary.
						const summary = String(this.getNodeParameter('summary', i, '') ?? '');
						const start = String(this.getNodeParameter('start', i, '') ?? '').trim();
						const end = String(this.getNodeParameter('end', i, '') ?? '').trim();
						const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
						const attendeesRaw = (additional.attendees as IDataObject)?.attendee as
							| Array<{ email: string; name?: string }>
							| undefined;
						const remindersRaw = (additional.reminders as IDataObject)?.reminder as
							| Array<{ minutesBefore: number; action?: 'DISPLAY' | 'EMAIL' }>
							| undefined;
						const eventUrl = located.eventUrl;

						// Read-modify-write. Fetching the current resource first is what
						// lets fields the caller didn't supply survive the update, and
						// its ETag guards against clobbering a concurrent edit.
						let existing;
						try {
							existing = await davRequest.call(this, 'GET', eventUrl, undefined, {
								Accept: 'text/calendar',
							});
						} catch (err) {
							if ((err as { httpCode?: string }).httpCode === '404') {
								throw new NodeOperationError(
									this.getNode(),
									`Event "${uid || eventUrl}" was not found in this calendar.`,
									{
										itemIndex: i,
										description:
											'Check that the UID is correct and that the event lives in the selected calendar. If you already have the event\'s URL from a read operation, supply it in the Event URL field.',
									},
								);
							}
							throw err;
						}
						const occurrence = (this.getNodeParameter('recurrenceId', i, '') as string).trim();
						if (!occurrence) guardRecurringSeries.call(this, existing.body, i, 'update');
						const currentIfMatch = ifMatchHeader(existing.headers.etag);

						const hasStart = start !== '';
						const hasEnd = end !== '';
						if (hasStart !== hasEnd) {
							throw new NodeOperationError(this.getNode(), 'Start and End must be updated together.', {
								itemIndex: i,
							});
						}
						const patch = {
							summary: summary || undefined,
							start: hasStart ? start : undefined,
							end: hasEnd ? end : undefined,
							description: additional.description as string | undefined,
							location: additional.location as string | undefined,
							allDay: additional.allDay as boolean | undefined,
							timezone: additional.timezone as string | undefined,
							rrule: additional.rrule as string | undefined,
							attendees: attendeesRaw,
							reminders: remindersRaw,
						};
						let iCal;
						try {
							iCal = occurrence
								? patchOccurrence(existing.body, occurrence, patch)
								: patchICalEvent(existing.body, patch);
						} catch (err) {
							throw new NodeOperationError(this.getNode(), (err as Error).message, {
								itemIndex: i,
							});
						}

						const putHeaders: Record<string, string> = {
							'Content-Type': 'text/calendar; charset=utf-8',
						};
						if (currentIfMatch) putHeaders['If-Match'] = currentIfMatch;
						let resp;
						try {
							resp = await davRequest.call(this, 'PUT', eventUrl, iCal, putHeaders);
						} catch (err) {
							if ((err as { httpCode?: string }).httpCode === '403') {
								rethrowWriteError.call(this, err, i, calUrlNormalised);
							}
							if ((err as { httpCode?: string }).httpCode === '412') {
								throw new NodeOperationError(
									this.getNode(),
									`Event "${uid}" was modified by someone else while this update was in flight.`,
									{
										itemIndex: i,
										description:
											'The update was rejected rather than overwriting the newer version. Re-read the event and retry.',
									},
								);
							}
							throw err;
						}
						const etag = etagValue(resp.headers.etag);
						returnData.push({
							json: {
								uid,
								url: eventUrl,
								etag,
								summary: summary || undefined,
								start: hasStart ? start : undefined,
								end: hasEnd ? end : undefined,
								recurrenceId: occurrence || undefined,
								updated: true,
							},
							pairedItem: { item: i },
						});
					} else if (operation === 'delete') {
						const { uid, eventUrl } = await locateEvent.call(this, i, calUrlNormalised, serverUrl);

						// Read before removing: this is what tells us whether the
						// resource holds a whole series, and its ETag makes the delete
						// conditional so a concurrent edit isn't discarded unseen.
						let stored;
						try {
							stored = await davRequest.call(this, 'GET', eventUrl, undefined, {
								Accept: 'text/calendar',
							});
						} catch (err) {
							if ((err as { httpCode?: string }).httpCode === '404') {
								throw new NodeOperationError(
									this.getNode(),
									`Event "${uid || eventUrl}" was not found in this calendar.`,
									{ itemIndex: i, description: 'Nothing was deleted.' },
								);
							}
							throw err;
						}
						const storedIfMatch = ifMatchHeader(stored.headers.etag);
						const occurrence = (this.getNodeParameter('recurrenceId', i, '') as string).trim();

						// Cancelling one date of a series is not a DELETE: the whole
						// series lives in this one resource, so the occurrence is
						// excluded and the resource written back.
						if (occurrence) {
							let excluded;
							try {
								excluded = removeOccurrence(stored.body, occurrence);
							} catch (err) {
								throw new NodeOperationError(this.getNode(), (err as Error).message, {
									itemIndex: i,
								});
							}
							const headers: Record<string, string> = {
								'Content-Type': 'text/calendar; charset=utf-8',
							};
							if (storedIfMatch) headers['If-Match'] = storedIfMatch;
							await davRequest
								.call(this, 'PUT', eventUrl, excluded, headers)
								.catch((err) => rethrowWriteError.call(this, err, i, calUrlNormalised));
							returnData.push({
								json: { uid, url: eventUrl, recurrenceId: occurrence, deleted: true },
								pairedItem: { item: i },
							});
							continue;
						}

						guardRecurringSeries.call(this, stored.body, i, 'delete');
						try {
							await davRequest.call(
								this,
								'DELETE',
								eventUrl,
								undefined,
								storedIfMatch ? { 'If-Match': storedIfMatch } : undefined,
							);
						} catch (err) {
							if ((err as { httpCode?: string }).httpCode === '412') {
								throw new NodeOperationError(
									this.getNode(),
									`Event "${uid || eventUrl}" was modified by someone else, so it was not deleted.`,
									{
										itemIndex: i,
										description: 'Re-read the event and retry if you still want it gone.',
									},
								);
							}
							rethrowWriteError.call(this, err, i, calUrlNormalised);
						}
						returnData.push({ json: { uid, url: eventUrl, deleted: true }, pairedItem: { item: i } });
					} else {
						throw new NodeOperationError(this.getNode(), `Unknown event operation: ${operation}`);
					}
				} else if (resource === 'icsFeed') {
					if (!['getAll', 'getNext', 'search'].includes(operation)) {
						throw new NodeOperationError(
							this.getNode(),
							`Unknown ICS feed operation: ${operation}`,
							{
								itemIndex: i,
								description:
									'A subscribed feed is read-only: only Get Many, Get Next and Search are available. Use the Event resource to write to a calendar.',
							},
						);
					}
					const currentFeedCreds = feedCreds!;
					const feedName = (currentFeedCreds.feedName ?? '').trim() || undefined;
					// Checked here, separately from the fetch, so a bad address is
					// reported against the credential rather than as a failed request —
					// and so no request is made at all.
					let feedUrl: string;
					try {
						feedUrl = assertSafeFeedUrl(String(currentFeedCreds.feedUrl ?? ''));
					} catch (err) {
						throw new NodeOperationError(this.getNode(), (err as Error).message, {
							itemIndex: i,
							description:
								'Open the ICS Feed credential and check the Feed URL. Only public HTTPS or webcal feeds on port 443 can be read.',
						});
					}

					const returnAll = this.getNodeParameter('returnAll', i) as boolean;
					const limit = returnAll ? Infinity : (this.getNodeParameter('limit', i) as number);
					const simplify = this.getNodeParameter('simplify', i, true) as boolean;
					const { rangeStart, rangeEnd, accept } = readWindow.call(this, i, operation);

					// One unauthenticated GET, memoised for the whole execution. Every
					// failure it can produce is already curated: no feed URL, no host,
					// no response body.
					let body: string;
					try {
						body = await fetchIcsFeed.call(this, feedUrl);
					} catch (err) {
						throw new NodeOperationError(this.getNode(), (err as Error).message, {
							itemIndex: i,
						});
					}

					// A feed is one static file, so the window is applied here rather
					// than by a server-side query.
					const events = expandIcsFeed(body, rangeStart, rangeEnd, this.getTimezone())
						.filter((event) => !accept || accept(event))
						.sort((a, b) => String(a.start ?? '').localeCompare(String(b.start ?? '')));
					for (const event of events.slice(0, limit)) {
						returnData.push({
							json: toFeedEvent(event, feedName, simplify),
							pairedItem: { item: i },
						});
					}
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown resource: ${resource}`);
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
