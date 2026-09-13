import { describe, expect, it, vi } from 'vitest';
import { CalDav } from '../nodes/CalDav/CalDav.node';
import { calendarDiagnostic } from '../nodes/CalDav/CalendarDiagnostics';

/**
 * Everything the dropdown must not echo back. The server URL is a credential
 * field in its own right — for several providers it contains a per-user token.
 */
const SECRETS = ['private-password', 'private-user', 'private-token', 'dav.example.com', 'https://'];

function context(outcome: number | Error) {
	return {
		getNode: () => ({ name: 'CalDAV', type: 'calDav', typeVersion: 1, id: 'n1' }),
		getNodeParameter: () => 'event',
		getCredentials: vi.fn(async () => ({
			serverUrl: 'https://dav.example.com/private-token/',
			username: 'private-user',
			password: 'private-password',
		})),
		logger: { debug: vi.fn() },
		helpers: {
			httpRequestWithAuthentication: vi.fn(async () => {
				if (outcome instanceof Error) throw outcome;
				return {
					statusCode: outcome,
					body: 'private-password https://dav.example.com/private-token/',
					headers: {},
				};
			}),
		},
	};
}

describe('calendar dropdown safe diagnostics', () => {
	it('distinguishes an empty discovery result from auth or connection failure', async () => {
		const ctx = context(207);
		const options = await new CalDav().methods.loadOptions.getCalendars.call(ctx as any);
		expect(options).toHaveLength(1);
		expect(options[0].name).toMatch(/no calendars.*permissions.*allow.*block/i);
		expect(options[0].value).toBe('');
	});

	it('does not leak a credential lookup error through the dropdown', async () => {
		const ctx = context(207);
		ctx.getCredentials.mockRejectedValue(
			new Error('private-password https://dav.example.com/private-token/'),
		);
		await expect(
			new CalDav().methods.loadOptions.getCalendars.call(ctx as any),
		).rejects.toThrow('CalDAV API credential is required');
		expect(ctx.helpers.httpRequestWithAuthentication).not.toHaveBeenCalled();
	});

	it.each([
		[401, /credentials were rejected.*401/i],
		[403, /access was denied.*403/i],
		[404, /discovery failed.*404/i],
		[503, /discovery failed.*503/i],
		[
			Object.assign(new Error('private-password https://dav.example.com/private-token/'), {
				code: 'ECONNREFUSED',
			}),
			/connection failed.*ECONNREFUSED/i,
		],
		[Object.assign(new Error('private-password'), { code: 'ETIMEDOUT' }), /connection failed.*ETIMEDOUT/i],
	])('reports a safe cause for %s', async (outcome, expected) => {
		const ctx = context(outcome as number | Error);
		let error: any;
		try {
			await new CalDav().methods.loadOptions.getCalendars.call(ctx as any);
		} catch (e) {
			error = e;
		}
		expect(error).toBeDefined();
		expect(error.message).toMatch(expected as RegExp);
		const serialized =
			JSON.stringify(error) +
			error.message +
			error.stack +
			JSON.stringify(ctx.logger.debug.mock.calls);
		for (const secret of SECRETS) expect(serialized).not.toContain(secret);
	});

	it('falls back to a generic message when nothing is classifiable', async () => {
		const ctx = context(new Error('private-password https://dav.example.com/private-token/'));
		let error: any;
		try {
			await new CalDav().methods.loadOptions.getCalendars.call(ctx as any);
		} catch (e) {
			error = e;
		}
		expect(error.message).toBe('Calendar discovery failed.');
		expect(error.description).toMatch(/raw details are hidden/i);
		const serialized = JSON.stringify(error) + error.message + error.stack;
		for (const secret of SECRETS) expect(serialized).not.toContain(secret);
	});
});

/**
 * Unit-level checks of the classifier itself. The cases above go through the
 * node, so they only reach the error shapes NodeApiError actually produces;
 * these cover the nested shapes the traversal defends against, which differ
 * between n8n versions and HTTP layers.
 */
describe('calendarDiagnostic classification', () => {
	it.each([
		['a top-level n8n httpCode', { httpCode: '401' }],
		['a nested cause', { cause: { statusCode: 401 } }],
		['an n8n errorResponse wrapper', { errorResponse: { response: { status: 401 } } }],
		['a numeric status two levels down', { cause: { response: { statusCode: 401 } } }],
	])('finds an HTTP 401 through %s', (_label, shape) => {
		expect(calendarDiagnostic(shape).cause).toBe('HTTP 401');
	});

	it('prefers an HTTP status over a connection code when both are present', () => {
		expect(calendarDiagnostic({ httpCode: '503', cause: { code: 'ETIMEDOUT' } }).cause).toBe(
			'HTTP 503',
		);
	});

	it('ignores a status that is not an HTTP client or server error', () => {
		expect(calendarDiagnostic({ statusCode: 207 }).cause).toBe('Unclassified discovery failure');
		expect(calendarDiagnostic({ statusCode: 302 }).cause).toBe('Unclassified discovery failure');
	});

	it('does not forward an unknown code that could carry user data', () => {
		const diagnostic = calendarDiagnostic({ code: 'https://dav.example.com/private-token/' });
		expect(diagnostic.cause).toBe('Unclassified discovery failure');
		expect(diagnostic.message + diagnostic.description).not.toContain('dav.example.com');
	});

	it('terminates on a self-referential error graph', () => {
		const loop: Record<string, unknown> = { code: 'ECONNREFUSED' };
		loop.cause = loop;
		expect(calendarDiagnostic(loop).cause).toBe('ECONNREFUSED');
	});

	it.each([null, undefined, 'plain string', 42])('classifies a non-object input: %s', (input) => {
		expect(calendarDiagnostic(input).cause).toBe('Unclassified discovery failure');
	});
});
