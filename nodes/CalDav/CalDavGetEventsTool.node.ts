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
		displayName: 'Date',
		name: 'date',
		type: 'string',
		default: '',
		placeholder: '2026-04-14',
		description:
			'Single day to query in YYYY-MM-DD. Leave empty to use Start Date + End Date. If all are empty, the current UTC day is used.',
	},
	{
		displayName: 'Start Date',
		name: 'startDate',
		type: 'string',
		default: '',
		placeholder: '2026-04-14 or 2026-04-14T00:00:00+02:00',
		description: 'Range start. Takes precedence over "Date" when both are provided.',
	},
	{
		displayName: 'End Date',
		name: 'endDate',
		type: 'string',
		default: '',
		placeholder: '2026-04-21 or 2026-04-21T23:59:59+02:00',
		description: 'Range end. Required when Start Date is provided.',
	},
	ERROR_HANDLING_PROPERTY,
];

const SPEC: BoundToolSpec = {
	operation: 'getEvents',
	toolName: 'caldav_get_events',
	toolDescription: [
		'Get calendar events for a date or date range.',
		'Provide either `date` (single YYYY-MM-DD day) or `startDate` + `endDate` (ISO-8601 with timezone offset).',
		'Returns an array of events. Empty array when no events match — never an error.',
	].join('\n'),
	buildSchema: () =>
		z.object({
			date: z
				.string()
				.optional()
				.describe('Single day as YYYY-MM-DD. Ignored when startDate/endDate are provided.'),
			startDate: z
				.string()
				.optional()
				.describe('Range start as ISO-8601, e.g. 2026-04-14T00:00:00+02:00.'),
			endDate: z.string().optional().describe('Range end as ISO-8601.'),
		}),
	uiProperties: UI_PROPERTIES,
};

export class CalDavGetEventsTool implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'CalDAV Get Events Tool',
		name: 'calDavGetEventsTool',
		icon: 'file:icons/caldav.svg',
		group: ['transform'],
		version: 1,
		description:
			'Get calendar events for a date or date range. AI Agent tool with a fixed `getEvents` operation.',
		defaults: { name: 'CalDAV Get Events' },
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
