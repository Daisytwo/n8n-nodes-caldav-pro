import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	INodeProperties,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { runOperation, SupportedOperation } from './helpers/Operations';
import { buildErrorPayload, normalizeParams } from './helpers/Utils';
import { CalDavCredentials } from './helpers/CalDavClient';
import {
	buildCalDavProperties,
	TOOL_OPERATION_DESCRIPTIONS,
} from './descriptions/SharedDescriptions';

/**
 * AI Agent tool variant of the CalDAV node.
 *
 * Differences from the standard node:
 *   - Every enum field is typed as `string` so `$fromAI()` values pass
 *     n8n's parameter validation regardless of casing.
 *   - Parameter names are normalised (camelCase / Underscore_Case /
 *     UPPER_CASE / kebab-case all accepted).
 *   - Error Handling defaults to `returnError` so a tool failure never
 *     aborts the surrounding Agent loop.
 */
export class CalDavTool implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'CalDAV Tool',
		name: 'caldavTool',
		icon: 'file:icons/caldav.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description:
			'CalDAV calendar operations exposed as an AI Agent tool. Accepts $fromAI() for every field and returns structured JSON for both success and failure.',
		defaults: { name: 'CalDAV Tool' },
		// Expose on the AI Tool connection so the node shows up in the Agent tool list.
		inputs: [],
		outputs: [NodeConnectionTypes.AiTool],
		outputNames: ['Tool'],
		credentials: [{ name: 'calDavApi', required: true }],
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Tools'],
			},
		},
		properties: buildToolProperties(),
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const credentials = (await this.getCredentials('calDavApi')) as unknown as CalDavCredentials;
		const tzid = this.getTimezone() || 'UTC';
		const errorHandling = this.getNodeParameter(
			'errorHandling',
			itemIndex,
			'returnError',
		) as 'returnError' | 'throwError';

		// Cast `this` to IExecuteFunctions for the helpers.* calls — the HTTP
		// helper surface is identical on both context types.
		const ctx = this as unknown as IExecuteFunctions;

		const call = async (input: Record<string, unknown>): Promise<IDataObject> => {
			const operation = (input.operation ??
				this.getNodeParameter('operation', itemIndex, 'getEvents')) as SupportedOperation;

			const staticParams = collectToolParams(ctx, itemIndex);
			const merged = { ...staticParams, ...input };
			const normalized = normalizeParams(merged);

			try {
				return await runOperation(ctx, credentials, operation, normalized, tzid);
			} catch (error) {
				if (errorHandling === 'throwError') throw error;
				return buildErrorPayload(error, operation) as unknown as IDataObject;
			}
		};

		return {
			response: {
				name: 'caldav',
				description:
					'Execute a CalDAV calendar operation (getEvents, createEvent, updateEvent, deleteEvent, getFreeBusy). Pick the operation and provide the fields it needs.',
				call,
			},
		} as unknown as SupplyData;
	}

	// Also expose a classic execute() so the node can be chained in non-Agent
	// workflows and tested directly. Behaviour matches the standard node but
	// honours the `errorHandling` setting.
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const results: INodeExecutionData[] = [];
		const credentials = (await this.getCredentials('calDavApi')) as unknown as CalDavCredentials;
		const tzid = this.getTimezone() || 'UTC';

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const operation = this.getNodeParameter('operation', itemIndex) as SupportedOperation;
			const errorHandling = (this.getNodeParameter(
				'errorHandling',
				itemIndex,
				'returnError',
			) as string) as 'returnError' | 'throwError';
			const params = collectToolParams(this, itemIndex);
			const normalized = normalizeParams(params);

			try {
				const output = await runOperation(this, credentials, operation, normalized, tzid);
				results.push({ json: output, pairedItem: { item: itemIndex } });
			} catch (error) {
				if (errorHandling === 'throwError' && !this.continueOnFail()) {
					throw error;
				}
				results.push({
					json: buildErrorPayload(error, operation) as unknown as IDataObject,
					pairedItem: { item: itemIndex },
				});
			}
		}

		return [results];
	}
}

function collectToolParams(ctx: IExecuteFunctions, itemIndex: number): Record<string, unknown> {
	const fields = [
		'date',
		'startDate',
		'endDate',
		'uid',
		'eventTitle',
		'startDateAndTime',
		'endDateAndTime',
		'location',
		'description',
		'allDayEvent',
		'reminder',
		'recurringEvent',
		'recurrenceFrequency',
		'recurrenceInterval',
		'recurrenceEndType',
		'recurrenceCount',
		'recurrenceUntil',
		'recurrenceByDay',
	];
	const out: Record<string, unknown> = {};
	for (const f of fields) {
		try {
			const v = ctx.getNodeParameter(f, itemIndex, undefined as unknown);
			if (v !== undefined && v !== '') out[f] = v;
		} catch {
			// not applicable
		}
	}
	return out;
}

/**
 * Tool-mode property set: append per-operation AI tool descriptions and an
 * "Error Handling" selector to the shared properties.
 */
function buildToolProperties(): INodeProperties[] {
	const base = buildCalDavProperties({ asTool: true });

	// Rewrite the operation property description to embed tool usage hints.
	const op = base.find((p) => p.name === 'operation');
	if (op) {
		op.description = [
			'Operation to perform:',
			`- getEvents: ${TOOL_OPERATION_DESCRIPTIONS.getEvents}`,
			`- createEvent: ${TOOL_OPERATION_DESCRIPTIONS.createEvent}`,
			`- updateEvent: ${TOOL_OPERATION_DESCRIPTIONS.updateEvent}`,
			`- deleteEvent: ${TOOL_OPERATION_DESCRIPTIONS.deleteEvent}`,
			`- getFreeBusy: ${TOOL_OPERATION_DESCRIPTIONS.getFreeBusy}`,
		].join('\n');
	}

	const errorHandling: INodeProperties = {
		displayName: 'Error Handling',
		name: 'errorHandling',
		type: 'options',
		default: 'returnError',
		options: [
			{
				name: 'Return Error as JSON (Default for AI Agent)',
				value: 'returnError',
				description: 'Return {success:false, error, operation, timestamp} instead of aborting the workflow',
			},
			{
				name: 'Throw Error (Stop Workflow)',
				value: 'throwError',
				description: 'Throw so the surrounding workflow or agent can surface the failure',
			},
		],
		description: 'How failures are surfaced. Defaults to returnError so the Agent never aborts.',
	};

	return [...base, errorHandling];
}
