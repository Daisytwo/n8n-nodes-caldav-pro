/**
 * Shared machinery for the four operation-bound AI tool nodes:
 * `CalDavGetEventsTool`, `CalDavCreateEventTool`, `CalDavUpdateEventTool`,
 * `CalDavDeleteEventTool`.
 *
 * Each bound tool advertises a focused zod schema (only the fields that
 * make sense for its single operation), and dispatches through the same
 * shared `runOperation()` backend. The operation itself is hard-coded and
 * never read from the LLM input.
 */

import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { z } from 'zod';

import { runOperation, SupportedOperation } from './Operations';
import { buildErrorPayload, normalizeParams } from './Utils';
import { normalizeAgentInput } from './AgentInput';
import { CalDavCredentials } from './CalDavClient';

export interface BoundToolSpec {
	/** Hard-coded CalDAV operation this tool performs. */
	operation: SupportedOperation;
	/** LangChain tool name advertised to the model. */
	toolName: string;
	/** Long, LLM-facing description — typically multiple lines. */
	toolDescription: string;
	/** zod schema builder — called once per supplyData(). */
	buildSchema: () => z.ZodTypeAny;
	/** n8n UI properties (fields the user can pre-configure in the editor). */
	uiProperties: INodeProperties[];
}

/**
 * Build the `supplyData` implementation used by an operation-bound
 * tool node. The factory captures the `operation` so the LLM cannot
 * override it via the input payload.
 */
export function makeSupplyData(spec: BoundToolSpec) {
	return async function supplyData(
		this: ISupplyDataFunctions,
		itemIndex: number,
	): Promise<SupplyData> {
		const credentials = (await this.getCredentials('calDavApi')) as unknown as CalDavCredentials;
		const tzid = this.getTimezone() || 'UTC';
		const errorHandling = this.getNodeParameter(
			'errorHandling',
			itemIndex,
			'returnError',
		) as 'returnError' | 'throwError';
		const ctx = this as unknown as IExecuteFunctions;

		// Cast the config to `any` — zod's recursive type inference on
		// larger object schemas trips TS's "type instantiation is
		// excessively deep" guard. The runtime shape is unchanged.
		const toolConfig: any = {
			name: spec.toolName,
			description: spec.toolDescription,
			schema: spec.buildSchema(),
			func: async (input: Record<string, unknown>) => {
				const agentInput = normalizeAgentInput(input);
				const staticParams = collectUiParams(ctx, itemIndex, spec.uiProperties);

				// The operation is locked — ignore anything the LLM may
				// have put in `operation` / `action` / etc.
				const merged = { ...staticParams, ...agentInput };
				const normalized = normalizeParams(merged);
				normalized.operation = spec.operation;

				try {
					const result = await runOperation(
						ctx,
						credentials,
						spec.operation,
						normalized,
						tzid,
					);
					return JSON.stringify(result);
				} catch (error) {
					if (errorHandling === 'throwError') throw error;
					return JSON.stringify(buildErrorPayload(error, spec.operation));
				}
			},
		};

		const tool = new DynamicStructuredTool(toolConfig);
		return { response: tool } as unknown as SupplyData;
	};
}

/**
 * Build the `execute` implementation for non-AI-agent usage. Mirrors
 * the standard node behaviour but honours the node's `errorHandling`
 * setting so a failure does not stop the workflow unexpectedly.
 */
export function makeExecute(spec: BoundToolSpec) {
	return async function execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const results: INodeExecutionData[] = [];
		const credentials = (await this.getCredentials('calDavApi')) as unknown as CalDavCredentials;
		const tzid = this.getTimezone() || 'UTC';

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const errorHandling = this.getNodeParameter(
				'errorHandling',
				itemIndex,
				'returnError',
			) as 'returnError' | 'throwError';
			const params = collectUiParams(this, itemIndex, spec.uiProperties);
			const normalized = normalizeParams(params);

			try {
				const output = await runOperation(this, credentials, spec.operation, normalized, tzid);
				results.push({ json: output, pairedItem: { item: itemIndex } });
			} catch (error) {
				if (errorHandling === 'throwError' && !this.continueOnFail()) {
					throw error;
				}
				results.push({
					json: buildErrorPayload(error, spec.operation) as unknown as IDataObject,
					pairedItem: { item: itemIndex },
				});
			}
		}

		return [results];
	};
}

/**
 * Read every UI property the node advertises — this provides the
 * static defaults for any field the LLM does not supply.
 */
function collectUiParams(
	ctx: IExecuteFunctions,
	itemIndex: number,
	properties: INodeProperties[],
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const prop of properties) {
		if (prop.name === 'errorHandling') continue;
		try {
			const v = ctx.getNodeParameter(prop.name, itemIndex, undefined as unknown);
			if (v !== undefined && v !== '') out[prop.name] = v;
		} catch {
			// not applicable for this item
		}
	}
	return out;
}

/**
 * The "Error Handling" property every bound tool exposes.
 */
export const ERROR_HANDLING_PROPERTY: INodeProperties = {
	displayName: 'Error Handling',
	name: 'errorHandling',
	type: 'options',
	default: 'returnError',
	options: [
		{
			name: 'Return Error as JSON (Default for AI Agent)',
			value: 'returnError',
			description:
				'Return {success:false, error, operation, timestamp} instead of aborting the workflow',
		},
		{
			name: 'Throw Error (Stop Workflow)',
			value: 'throwError',
			description: 'Throw so the surrounding workflow or agent can surface the failure',
		},
	],
	description: 'How failures are surfaced. Defaults to returnError so the Agent never aborts.',
};
