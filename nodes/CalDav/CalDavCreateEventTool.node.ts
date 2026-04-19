import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	INodeProperties,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { z } from 'zod';

import {
	BoundToolSpec,
	ERROR_HANDLING_PROPERTY,
	makeExecute,
	makeSupplyData,
} from './helpers/ToolNodeFactory';

const UI_PROPERTIES: INodeProperties[] = [
	{
		displayName: 'Event Title',
		name: 'eventTitle',
		type: 'string',
		default: '',
		description: 'Summary / title of the event. Required.',
	},
	{
		displayName: 'Start Date and Time',
		name: 'startDateAndTime',
		type: 'string',
		default: '',
		placeholder: '2026-04-14T12:00:00+02:00',
		description:
			'ISO-8601 datetime with timezone offset, e.g. 2026-04-14T12:00:00+02:00. For all-day events, YYYY-MM-DD is accepted.',
	},
	{
		displayName: 'End Date and Time',
		name: 'endDateAndTime',
		type: 'string',
		default: '',
		placeholder: '2026-04-14T13:00:00+02:00',
		description: 'Defaults to Start + 1 hour when empty',
	},
	{
		displayName: 'Location',
		name: 'location',
		type: 'string',
		default: '',
	},
	{
		displayName: 'Description',
		name: 'description',
		type: 'string',
		typeOptions: { rows: 3 },
		default: '',
		description: 'Free-form description / notes',
	},
	{
		displayName: 'All Day Event',
		name: 'allDayEvent',
		type: 'boolean',
		default: false,
		description: 'Whether the event should be stored as a DATE-only all-day event',
	},
	{
		displayName: 'Reminder (Minutes Before Start)',
		name: 'reminder',
		type: 'number',
		typeOptions: { minValue: 0 },
		default: 0,
		description:
			'Minutes before start to trigger a VALARM. 0 means no reminder. Generates a DISPLAY VALARM block.',
	},
	{
		displayName: 'Recurring Event',
		name: 'recurringEvent',
		type: 'boolean',
		default: false,
		description: 'Whether the event should repeat',
	},
	{
		displayName: 'Recurrence Frequency',
		name: 'recurrenceFrequency',
		type: 'string',
		default: 'WEEKLY',
		displayOptions: { show: { recurringEvent: [true] } },
		description: 'How often the event recurs. Allowed values: DAILY, WEEKLY, MONTHLY, YEARLY.',
	},
	{
		displayName: 'Recurrence Interval',
		name: 'recurrenceInterval',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 1,
		displayOptions: { show: { recurringEvent: [true] } },
		description: 'Interval between recurrences (e.g. every 2 weeks)',
	},
	{
		displayName: 'Recurrence End Type',
		name: 'recurrenceEndType',
		type: 'string',
		default: 'never',
		displayOptions: { show: { recurringEvent: [true] } },
		description: 'How the recurrence terminates. Allowed values: never, count, until.',
	},
	{
		displayName: 'Recurrence Count',
		name: 'recurrenceCount',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 10,
		displayOptions: {
			show: { recurringEvent: [true], recurrenceEndType: ['count'] },
		},
		description: 'Total number of occurrences (including the first)',
	},
	{
		displayName: 'Recurrence Until',
		name: 'recurrenceUntil',
		type: 'string',
		default: '',
		placeholder: '2026-12-31T23:59:59Z',
		displayOptions: {
			show: { recurringEvent: [true], recurrenceEndType: ['until'] },
		},
		description: 'Recurrence ends on or before this ISO datetime',
	},
	{
		displayName: 'Recurrence By Day',
		name: 'recurrenceByDay',
		type: 'string',
		default: '',
		placeholder: 'MO,WE,FR',
		displayOptions: { show: { recurringEvent: [true] } },
		description:
			'Comma-separated BYDAY tokens. Allowed values: MO, TU, WE, TH, FR, SA, SU. Ordinals allowed, e.g. 2MO or -1FR.',
	},
	{
		displayName: 'UID (Optional)',
		name: 'uid',
		type: 'string',
		default: '',
		description:
			'Custom UID. If empty a UUID is generated. Characters outside [A-Za-z0-9._-@] are replaced with _.',
	},
	ERROR_HANDLING_PROPERTY,
];

const SPEC: BoundToolSpec = {
	operation: 'createEvent',
	toolName: 'caldav_create_event',
	toolDescription: [
		'Create a new calendar event.',
		'Required: `eventTitle`, `startDateAndTime`.',
		'`endDateAndTime` defaults to start + 1 hour when omitted.',
		'For recurring events set `recurringEvent=true` and provide recurrence fields.',
		'All datetimes must be ISO-8601 with timezone offset (e.g. 2026-04-14T12:00:00+02:00).',
	].join('\n'),
	buildSchema: () =>
		z.object({
			eventTitle: z.string().describe('Event title / SUMMARY. Required.'),
			startDateAndTime: z
				.string()
				.describe('Start datetime ISO-8601 with timezone offset. Required.'),
			endDateAndTime: z
				.string()
				.optional()
				.describe('End datetime ISO-8601. Defaults to start + 1 hour.'),
			location: z.string().optional().describe('LOCATION property.'),
			description: z.string().optional().describe('DESCRIPTION / free-form notes.'),
			allDayEvent: z.boolean().optional().describe('Store as DATE-only all-day event.'),
			reminder: z
				.number()
				.optional()
				.describe('Minutes before start to trigger a VALARM. 0 disables the reminder.'),
			recurringEvent: z.boolean().optional().describe('Set true for recurring events.'),
			recurrenceFrequency: z
				.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])
				.optional()
				.describe('How often the event recurs.'),
			recurrenceInterval: z.number().optional().describe('Interval between recurrences. Default 1.'),
			recurrenceEndType: z
				.enum(['never', 'count', 'until'])
				.optional()
				.describe('How the recurrence terminates.'),
			recurrenceCount: z
				.number()
				.optional()
				.describe('Total occurrences when recurrenceEndType=count.'),
			recurrenceUntil: z
				.string()
				.optional()
				.describe('ISO-8601 end when recurrenceEndType=until.'),
			recurrenceByDay: z
				.string()
				.optional()
				.describe(
					'Comma-separated BYDAY tokens. Allowed: MO, TU, WE, TH, FR, SA, SU. Ordinals allowed (e.g. 2MO, -1FR).',
				),
			uid: z
				.string()
				.optional()
				.describe('Optional custom UID. Auto-generated when empty.'),
		}),
	uiProperties: UI_PROPERTIES,
};

export class CalDavCreateEventTool implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'CalDAV Create Event Tool',
		name: 'calDavCreateEventTool',
		icon: 'file:icons/caldav.svg',
		group: ['transform'],
		version: 1,
		description: 'Create a new calendar event. AI Agent tool with a fixed `createEvent` operation.',
		defaults: { name: 'CalDAV Create Event' },
		inputs: [],
		outputs: [NodeConnectionTypes.AiTool],
		outputNames: ['Tool'],
		credentials: [{ name: 'calDavApi', required: true }],
		codex: {
			categories: ['AI'],
			subcategories: { AI: ['Tools'] },
		},
		properties: UI_PROPERTIES,
	};

	supplyData = makeSupplyData(SPEC) as (
		this: ISupplyDataFunctions,
		itemIndex: number,
	) => Promise<SupplyData>;

	execute = makeExecute(SPEC) as (this: IExecuteFunctions) => Promise<INodeExecutionData[][]>;
}
