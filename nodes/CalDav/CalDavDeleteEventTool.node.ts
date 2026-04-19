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
		description: 'UID of the event to delete',
	},
	ERROR_HANDLING_PROPERTY,
];

const SPEC: BoundToolSpec = {
	operation: 'deleteEvent',
	toolName: 'caldav_delete_event',
	toolDescription: [
		'Delete a calendar event by UID.',
		'Required: `uid`. Returns `{deleted: false}` when the event does not exist — never throws on a 404.',
	].join('\n'),
	buildSchema: () =>
		z.object({
			uid: z.string().describe('UID of the event to delete. Required.'),
		}),
	uiProperties: UI_PROPERTIES,
};

export class CalDavDeleteEventTool implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'CalDAV Delete Event Tool',
		name: 'calDavDeleteEventTool',
		icon: 'file:icons/caldav.svg',
		group: ['transform'],
		version: 1,
		description:
			'Delete a calendar event by UID. AI Agent tool with a fixed `deleteEvent` operation.',
		defaults: { name: 'CalDAV Delete Event' },
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
