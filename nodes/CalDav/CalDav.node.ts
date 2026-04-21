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
	buildTimeRangeReport,
	parseCalendarQueryResponse,
	parseICalEvent,
} from './GenericFunctions';
import { calendarOperations, calendarFields } from './CalendarDescription';
import { eventOperations, eventFields } from './EventDescription';

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
				return calendars.map((c) => ({
					name: c.displayName,
					value: c.url,
				}));
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
					const calUrlNormalised = calendarUrl.endsWith('/') ? calendarUrl : `${calendarUrl}/`;

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
						const resp = await davRequest.call(this, 'PUT', eventUrl, iCal, {
							'Content-Type': 'text/calendar; charset=utf-8',
							'If-None-Match': '*',
						});
						const etag = (resp.headers.etag as string | undefined)?.replace(/"/g, '');
						returnData.push({
							json: { uid, url: eventUrl, etag, summary, start, end },
							pairedItem: { item: i },
						});
					} else if (operation === 'get') {
						const uid = this.getNodeParameter('uid', i) as string;
						const eventUrl = `${calUrlNormalised}${encodeURIComponent(uid)}.ics`;
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
						returnData.push({ json: parsed as unknown as IDataObject, pairedItem: { item: i } });
					} else if (operation === 'getAll') {
						const timeMin = this.getNodeParameter('timeMin', i) as string;
						const timeMax = this.getNodeParameter('timeMax', i) as string;
						const returnAll = this.getNodeParameter('returnAll', i) as boolean;
						const limit = returnAll ? Infinity : (this.getNodeParameter('limit', i) as number);
						const body = buildTimeRangeReport(timeMin, timeMax);
						const resp = await davRequest.call(this, 'REPORT', calUrlNormalised, body, {
							Depth: '1',
							'Content-Type': 'application/xml; charset=utf-8',
						});
						const events = parseCalendarQueryResponse(resp.body, calUrlNormalised, serverUrl);
						const sliced = events.slice(0, limit);
						for (const ev of sliced) {
							returnData.push({ json: ev as unknown as IDataObject, pairedItem: { item: i } });
						}
					} else if (operation === 'update') {
						const uid = this.getNodeParameter('uid', i) as string;
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
						const resp = await davRequest.call(this, 'PUT', eventUrl, iCal, {
							'Content-Type': 'text/calendar; charset=utf-8',
						});
						const etag = (resp.headers.etag as string | undefined)?.replace(/"/g, '');
						returnData.push({
							json: { uid, url: eventUrl, etag, summary, start, end, updated: true },
							pairedItem: { item: i },
						});
					} else if (operation === 'delete') {
						const uid = this.getNodeParameter('uid', i) as string;
						const eventUrl = `${calUrlNormalised}${encodeURIComponent(uid)}.ics`;
						await davRequest.call(this, 'DELETE', eventUrl);
						returnData.push({ json: { uid, deleted: true }, pairedItem: { item: i } });
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
