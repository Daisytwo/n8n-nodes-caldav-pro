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
	davRequest,
	discoverCalendars,
	buildICalEvent,
	patchICalEvent,
	buildTimeRangeReport,
	parseCalendarQueryResponse,
	parseICalEvent,
	resolveDefaultCalendar,
	resolveEventUrl,
	seriesRecurrenceRule,
	simplifyEvent,
	eventMatchesText,
	type CalDavEvent,
} from './GenericFunctions';
import { calendarOperations, calendarFields } from './CalendarDescription';
import { eventOperations, eventFields } from './EventDescription';

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
				'Turn on "Entire Series" to confirm that is what you want. Changing or removing a single occurrence is not supported yet — all occurrences share one UID and one resource on the server.',
		},
	);
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
	const eventUrl = await resolveEventUrl.call(this, calendarUrl, uid, explicitUrl, serverUrl);
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
	const targets =
		calendarUrl === '__ALL__'
			? (await discoverCalendars.call(this, serverUrl, username)).map((c) => ({
					url: c.url.endsWith('/') ? c.url : `${c.url}/`,
					displayName: c.displayName,
				}))
			: [{ url: calendarUrl, displayName: '' }];

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
			'Read and write calendar events over CalDAV (Infomaniak, NextCloud, iCloud, Fastmail, Synology). Works as an AI Agent tool.',
		defaults: {
			name: 'CalDAV',
		},
		usableAsTool: true,
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'calDavApi',
				required: true,
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
				],
				default: 'event',
			},
			...calendarOperations,
			...calendarFields,
			...eventOperations,
			...eventFields,
		],
	};

	methods = {
		loadOptions: {
			async getCalendars(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const creds = await this.getCredentials('calDavApi');
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
		const creds = await this.getCredentials('calDavApi');
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
							: resolvedUrl.endsWith('/')
								? resolvedUrl
								: `${resolvedUrl}/`;

					if (operation === 'create') {
						const summary = this.getNodeParameter('summary', i) as string;
						const start = this.getNodeParameter('start', i) as string;
						const end = this.getNodeParameter('end', i) as string;
						const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
						const attendeesRaw = (additional.attendees as IDataObject)?.attendee as
							| Array<{ email: string; name?: string }>
							| undefined;
						const remindersRaw = (additional.reminders as IDataObject)?.reminder as
							| Array<{ minutesBefore: number; action?: 'DISPLAY' | 'EMAIL' }>
							| undefined;
						const uid = (additional.uid as string) || randomUUID();
						const iCal = buildICalEvent({
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
						const eventUrl = `${calUrlNormalised}${encodeURIComponent(uid)}.ics`;
						const resp = await davRequest
							.call(this, 'PUT', eventUrl, iCal, {
								'Content-Type': 'text/calendar; charset=utf-8',
								'If-None-Match': '*',
							})
							.catch((err) => rethrowWriteError.call(this, err, i, calUrlNormalised));
						const etag = (resp.headers.etag as string | undefined)?.replace(/"/g, '');
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
						const parsed = parseICalEvent(resp.body, eventUrl, (resp.headers.etag as string | undefined)?.replace(/"/g, ''));
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

						let rangeStart: Date;
						let rangeEnd: Date;
						let accept: ((event: CalDavEvent) => boolean) | undefined;

						if (operation === 'getNext') {
							const lookaheadDays = this.getNodeParameter('lookaheadDays', i, 30) as number;
							rangeStart = new Date();
							rangeEnd = new Date(rangeStart.getTime() + lookaheadDays * 24 * 60 * 60 * 1000);
							// A series can start before "now" and still have an occurrence
							// inside the window; only drop the ones already past.
							const from = rangeStart;
							accept = (event) => !event.start || new Date(event.start) >= from;
						} else {
							rangeStart = readWindowBound.call(this, i, 'timeMin', 'Time Min');
							rangeEnd = readWindowBound.call(this, i, 'timeMax', 'Time Max');
							if (operation === 'search') {
								const query = this.getNodeParameter('query', i) as string;
								accept = (event) => eventMatchesText(event, query);
							}
						}

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
						const located = await locateEvent.call(this, i, calUrlNormalised, serverUrl);
						const targetCalendarRaw = this.getNodeParameter('targetCalendar', i) as string;
						if (!targetCalendarRaw) {
							throw new NodeOperationError(this.getNode(), 'Target Calendar is required for the Move operation.', { itemIndex: i });
						}
						if (targetCalendarRaw === '__ALL__') {
							throw new NodeOperationError(this.getNode(), '"All Calendars" is not a valid target for Move. Pick a specific destination.', { itemIndex: i });
						}
						const targetUrl =
							targetCalendarRaw === '__DEFAULT__'
								? await resolveDefaultCalendar.call(this, serverUrl, username)
								: targetCalendarRaw.endsWith('/')
									? targetCalendarRaw
									: `${targetCalendarRaw}/`;
						if (targetUrl === calUrlNormalised) {
							throw new NodeOperationError(this.getNode(), 'Source and target calendars are identical — nothing to move.', { itemIndex: i });
						}
						const sourceEventUrl = located.eventUrl;
						const getResp = await davRequest.call(this, 'GET', sourceEventUrl, undefined, { Accept: 'text/calendar' });
						const sourceEtag = (getResp.headers.etag as string | undefined)?.replace(/"/g, '');
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
						const newEtag = (putResp.headers.etag as string | undefined)?.replace(/"/g, '');
						await davRequest.call(this, 'DELETE', sourceEventUrl, undefined, sourceEtag ? { 'If-Match': `"${sourceEtag}"` } : undefined);
						returnData.push({
							json: { uid, oldUrl: sourceEventUrl, newUrl: targetEventUrl, etag: newEtag, moved: true },
							pairedItem: { item: i },
						});
					} else if (operation === 'update') {
						const located = await locateEvent.call(this, i, calUrlNormalised, serverUrl);
						const uid = located.uid;
						const summary = this.getNodeParameter('summary', i) as string;
						const start = this.getNodeParameter('start', i) as string;
						const end = this.getNodeParameter('end', i) as string;
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
						guardRecurringSeries.call(this, existing.body, i, 'update');
						const currentEtag = (existing.headers.etag as string | undefined)?.replace(/"/g, '');

						const iCal = patchICalEvent(existing.body, {
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

						const putHeaders: Record<string, string> = {
							'Content-Type': 'text/calendar; charset=utf-8',
						};
						if (currentEtag) putHeaders['If-Match'] = `"${currentEtag}"`;
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
						const etag = (resp.headers.etag as string | undefined)?.replace(/"/g, '');
						returnData.push({
							json: { uid, url: eventUrl, etag, summary, start, end, updated: true },
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
						guardRecurringSeries.call(this, stored.body, i, 'delete');

						const storedEtag = (stored.headers.etag as string | undefined)?.replace(/"/g, '');
						try {
							await davRequest.call(
								this,
								'DELETE',
								eventUrl,
								undefined,
								storedEtag ? { 'If-Match': `"${storedEtag}"` } : undefined,
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
