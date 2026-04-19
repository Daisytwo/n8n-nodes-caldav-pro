import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	runOperation,
	SupportedOperation,
} from './helpers/Operations';
import { buildErrorPayload, normalizeParams } from './helpers/Utils';
import { CalDavCredentials } from './helpers/CalDavClient';
import { buildCalDavProperties } from './descriptions/SharedDescriptions';

export class CalDav implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'CalDAV',
		name: 'caldav',
		icon: 'file:icons/caldav.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Read and write events on a CalDAV calendar (Infomaniak, Nextcloud, iCloud, Radicale, Baikal, SOGo).',
		defaults: { name: 'CalDAV' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'calDavApi', required: true }],
		properties: buildCalDavProperties({ asTool: false }),
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const results: INodeExecutionData[] = [];

		const credentials = (await this.getCredentials('calDavApi')) as unknown as CalDavCredentials;
		const tzid = this.getTimezone() || 'UTC';

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const operation = this.getNodeParameter('operation', itemIndex) as SupportedOperation;
				const params = collectParams(this, itemIndex);
				const normalized = normalizeParams(params);

				const output = await runOperation(this, credentials, operation, normalized, tzid);
				results.push({ json: output, pairedItem: { item: itemIndex } });
			} catch (error) {
				const operation =
					((): string => {
						try {
							return this.getNodeParameter('operation', itemIndex) as string;
						} catch {
							return 'unknown';
						}
					})();

				if (this.continueOnFail()) {
					results.push({
						json: buildErrorPayload(error, operation) as unknown as IDataObject,
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				if (error instanceof NodeOperationError) throw error;
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			}
		}

		return [results];
	}
}

/**
 * Pull every parameter the operation might consume. Missing parameters yield
 * `undefined` which downstream normalisation treats as "not provided".
 */
function collectParams(ctx: IExecuteFunctions, itemIndex: number): Record<string, unknown> {
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
			// Parameter not applicable to this operation — skip.
		}
	}
	return out;
}
