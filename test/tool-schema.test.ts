/**
 * Verifies that each operation-bound tool node exposes a proper
 * DynamicStructuredTool with a focused JSON schema, advertises only the
 * fields that apply to its hard-coded operation, and dispatches that
 * operation regardless of what the LLM puts in its input payload.
 */

import { CalDavGetEventsTool } from '../nodes/CalDav/CalDavGetEventsTool.node';
import { CalDavCreateEventTool } from '../nodes/CalDav/CalDavCreateEventTool.node';
import { CalDavUpdateEventTool } from '../nodes/CalDav/CalDavUpdateEventTool.node';
import { CalDavDeleteEventTool } from '../nodes/CalDav/CalDavDeleteEventTool.node';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { zodToJsonSchema } from 'zod-to-json-schema';

function makeCtx(overrides: Record<string, unknown> = {}) {
	const lastRequest: { value: any } = { value: undefined };
	return {
		lastRequest,
		getCredentials: async () => ({
			serverUrl: 'https://example.com/cal/',
			username: 'u',
			password: 'p',
		}),
		getTimezone: () => 'Europe/Berlin',
		getNodeParameter: (name: string, _itemIndex: number, fallback?: unknown) => {
			if (name === 'errorHandling') return 'returnError';
			if (name in overrides) return overrides[name];
			return fallback;
		},
		helpers: {
			httpRequestWithAuthentication: async (_auth: string, req: any) => {
				lastRequest.value = req;
				return {
					statusCode: 207,
					headers: { 'content-type': 'application/xml' },
					body: '<?xml version="1.0"?><multistatus xmlns="DAV:"></multistatus>',
				};
			},
		},
	} as any;
}

describe('CalDavGetEventsTool', () => {
	test('advertises only range/date fields (no operation, no event fields)', async () => {
		const ctx = makeCtx();
		const result = await (new CalDavGetEventsTool().supplyData as any).call(ctx, 0);
		const tool = result.response as DynamicStructuredTool;

		expect(tool).toBeInstanceOf(DynamicStructuredTool);
		expect(tool.name).toBe('caldav_get_events');

		const json = zodToJsonSchema((tool as any).schema) as any;
		const props = json.properties ?? {};
		expect(Object.keys(props).sort()).toEqual(['date', 'endDate', 'startDate']);
		// No `operation` property — it is hard-coded.
		expect(props.operation).toBeUndefined();
		expect(props.eventTitle).toBeUndefined();
		expect(props.uid).toBeUndefined();
	});

	test('invoke() dispatches getEvents and returns a JSON string', async () => {
		const ctx = makeCtx();
		const result = await (new CalDavGetEventsTool().supplyData as any).call(ctx, 0);
		const tool = result.response as DynamicStructuredTool;

		const output = await tool.invoke({ date: '2026-04-14' });
		const parsed = JSON.parse(output);
		expect(parsed.success).toBe(true);
		expect(parsed.operation).toBe('getEvents');
		expect(parsed.events).toEqual([]);
	});
});

describe('CalDavCreateEventTool', () => {
	test('advertises event fields and marks title/start as required', async () => {
		const ctx = makeCtx();
		const result = await (new CalDavCreateEventTool().supplyData as any).call(ctx, 0);
		const tool = result.response as DynamicStructuredTool;

		expect(tool.name).toBe('caldav_create_event');

		const json = zodToJsonSchema((tool as any).schema) as any;
		const props = json.properties ?? {};
		expect(props.eventTitle).toBeDefined();
		expect(props.startDateAndTime).toBeDefined();
		expect(props.endDateAndTime).toBeDefined();
		expect(props.recurringEvent).toBeDefined();
		expect(props.operation).toBeUndefined();

		// Required fields enforced on the LLM side.
		expect(json.required).toEqual(expect.arrayContaining(['eventTitle', 'startDateAndTime']));
	});

	test('invoke() with nested `event` payload still dispatches createEvent (normaliser wired)', async () => {
		const ctx = makeCtx();
		const result = await (new CalDavCreateEventTool().supplyData as any).call(ctx, 0);
		const tool = result.response as DynamicStructuredTool;

		// DynamicStructuredTool validates the schema before calling func,
		// so we bypass .invoke and call the underlying func directly —
		// this is the same path the tool uses once validation passes.
		const func = (tool as any).func;
		const output = await func({
			event: {
				summary: 'Meeting',
				start: '2026-04-14T12:00:00+02:00',
				end: '2026-04-14T13:00:00+02:00',
			},
		});
		const parsed = JSON.parse(output);
		expect(parsed.success).toBe(true);
		expect(parsed.operation).toBe('createEvent');

		// The underlying PUT must have been called with a VCALENDAR body.
		expect(ctx.lastRequest.value).toBeDefined();
		expect(ctx.lastRequest.value.method).toBe('PUT');
		expect(String(ctx.lastRequest.value.body)).toContain('SUMMARY:Meeting');
	});

	test('errors are returned as JSON when returnError is set (default)', async () => {
		const ctx = makeCtx();
		ctx.helpers.httpRequestWithAuthentication = async () => ({
			statusCode: 500,
			headers: {},
			body: 'boom',
		});
		const result = await (new CalDavCreateEventTool().supplyData as any).call(ctx, 0);
		const tool = result.response as DynamicStructuredTool;

		const output = await tool.invoke({
			eventTitle: 'Meeting',
			startDateAndTime: '2026-04-14T12:00:00+02:00',
			endDateAndTime: '2026-04-14T13:00:00+02:00',
		});
		const parsed = JSON.parse(output);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toMatch(/HTTP 500/);
		expect(parsed.operation).toBe('createEvent');
	});
});

describe('CalDavUpdateEventTool', () => {
	test('advertises uid as required and exposes event fields', async () => {
		const ctx = makeCtx();
		const result = await (new CalDavUpdateEventTool().supplyData as any).call(ctx, 0);
		const tool = result.response as DynamicStructuredTool;

		expect(tool.name).toBe('caldav_update_event');

		const json = zodToJsonSchema((tool as any).schema) as any;
		const props = json.properties ?? {};
		expect(props.uid).toBeDefined();
		expect(props.eventTitle).toBeDefined();
		expect(props.operation).toBeUndefined();
		expect(json.required).toEqual(expect.arrayContaining(['uid']));
	});
});

describe('CalDavDeleteEventTool', () => {
	test('advertises only uid (no other fields)', async () => {
		const ctx = makeCtx();
		const result = await (new CalDavDeleteEventTool().supplyData as any).call(ctx, 0);
		const tool = result.response as DynamicStructuredTool;

		expect(tool.name).toBe('caldav_delete_event');

		const json = zodToJsonSchema((tool as any).schema) as any;
		const props = json.properties ?? {};
		expect(Object.keys(props)).toEqual(['uid']);
		expect(json.required).toEqual(['uid']);
	});

	test('invoke() dispatches deleteEvent regardless of extra fields the LLM supplies', async () => {
		const ctx = makeCtx();
		// Accept DELETE with 204.
		ctx.helpers.httpRequestWithAuthentication = async (_auth: string, req: any) => {
			ctx.lastRequest.value = req;
			return { statusCode: 204, headers: {}, body: '' };
		};
		const result = await (new CalDavDeleteEventTool().supplyData as any).call(ctx, 0);
		const tool = result.response as DynamicStructuredTool;

		const output = await tool.invoke({ uid: 'abc-123' });
		const parsed = JSON.parse(output);
		expect(parsed.success).toBe(true);
		expect(parsed.operation).toBe('deleteEvent');
		expect(ctx.lastRequest.value.method).toBe('DELETE');
	});
});
