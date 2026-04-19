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
		displayName: 'UID',
		name: 'uid',
		type: 'string',
		default: '',
		required: true,
		description: 'UID of the event to modify',
	},
	{
		displayName: 'Event Title',
		name: 'eventTitle',
		type: 'string',
		default: '',
		description: 'New summary / title. Leave empty to keep existing.',
	},
	{
		displayName: 'Start Date and Time',
		name: 'startDateAndTime',
		type: 'string',
		default: '',
		placeholder: '2026-04-14T12:00:00+02:00',
		description: 'ISO-8601 with timezone offset. Leave empty to keep existing.',
	},
	{
		displayName: 'End Date and Time',
		name: 'endDateAndTime',
		type: 'string',
		default: '',
		placeholder: '2026-04-14T13:00:00+02:00',
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
	},
	{
		displayName: 'All Day Event',
		name: 'allDayEvent',
		type: 'boolean',
		default: false,
	},
	{
		displayName: 'Reminder (Minutes Before Start)',
		name: 'reminder',
		type: 'number',
		typeOptions: { minValue: 0 },
		default: 0,
	},
	{
		displayName: 'Recurring Event',
		name: 'recurringEvent',
		type: 'boolean',
		default: false,
	},
	{
		displayName: 'Recurrence Frequency',
		name: 'recurrenceFrequency',
		type: 'string',
		default: 'WEEKLY',
		displayOptions: { show: { recurringEvent: [true] } },
		description: 'Allowed values: DAILY, WEEKLY, MONTHLY, YEARLY',
	},
	{
		displayName: 'Recurrence Interval',
		name: 'recurrenceInterval',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 1,
		displayOptions: { show: { recurringEvent: [true] } },
	},
	{
		displayName: 'Recurrence End Type',
		name: 'recurrenceEndType',
		type: 'string',
		default: 'never',
		displayOptions: { show: { recurringEvent: [true] } },
		description: 'Allowed values: never, count, until',
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
	},
	{
		displayName: 'Recurrence Until',
		name: 'recurrenceUntil',
		type: 'string',
		default: '',
		displayOptions: {
			show: { recurringEvent: [true], recurrenceEndType: ['until'] },
		},
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
	ERROR_HANDLING_PROPERTY,
];

const SPEC: BoundToolSpec = {
	operation: 'updateEvent',
	toolName: 'caldav_update_event',
	toolDescription: [
		'Update an existing calendar event by UID.',
		'Required: `uid`. Any other field is optional — omit fields you do not want to change.',
		'All datetimes must be ISO-8601 with timezone offset.',
	].join('\n'),
	buildSchema: () =>
		z.object({
			uid: z.string().describe('UID of the event to modify. Required.'),
			eventTitle: z.string().optional().describe('New SUMMARY / title.'),
			startDateAndTime: z
				.string()
				.optional()
				.describe('New start datetime (ISO-8601 with timezone offset).'),
			endDateAndTime: z.string().optional().describe('New end datetime (ISO-8601).'),
			location: z.string().optional(),
			description: z.string().optional(),
			allDayEvent: z.boolean().optional(),
			reminder: z.number().optional().describe('Minutes before start. 0 disables the reminder.'),
			recurringEvent: z.boolean().optional(),
			recurrenceFrequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']).optional(),
			recurrenceInterval: z.number().optional(),
			recurrenceEndType: z.enum(['never', 'count', 'until']).optional(),
			recurrenceCount: z.number().optional(),
			recurrenceUntil: z.string().optional(),
			recurrenceByDay: z
				.string()
				.optional()
				.describe(
					'Comma-separated BYDAY tokens. Allowed: MO, TU, WE, TH, FR, SA, SU. Ordinals allowed.',
				),
		}),
	uiProperties: UI_PROPERTIES,
};

export class CalDavUpdateEventTool implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'CalDAV Update Event Tool',
		name: 'calDavUpdateEventTool',
		icon: 'file:icons/caldav.svg',
		group: ['transform'],
		version: 1,
		description:
			'Update an existing calendar event by UID. AI Agent tool with a fixed `updateEvent` operation.',
		defaults: { name: 'CalDAV Update Event' },
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
