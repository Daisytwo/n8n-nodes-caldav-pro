import { describe, expect, it, vi } from 'vitest';
import { CalDav } from '../nodes/CalDav/CalDav.node';

function context(resource: string, credentials: Record<string, unknown> = {}) {
	return {
		getInputData: () => [{ json: {} }],
		getNode: () => ({ name: 'CalDAV', type: 'calDav', typeVersion: 1, id: 'n1' }),
		getNodeParameter: (name: string) => name === 'resource' ? resource : 'getAll',
		getCredentials: vi.fn(async () => credentials),
		continueOnFail: () => false,
		helpers: { httpRequest: vi.fn(), httpRequestWithAuthentication: vi.fn() },
	};
}

describe('runtime credential requirement', () => {
	it.each(['serverUrl', 'username', 'password'])('rejects incomplete CalDAV credentials: %s', async (missing) => {
		const creds = { serverUrl: 'https://dav.example.com/', username: 'bob', password: 'test', [missing]: '' };
		const ctx = context('calendar', creds);
		await expect(new CalDav().execute.call(ctx as any)).rejects.toThrow('CalDAV API credential is required');
		expect(ctx.helpers.httpRequestWithAuthentication).not.toHaveBeenCalled();
	});
	it.each(['calendar', 'event', 'icsFeed'])('propagates a credential lookup failure for %s without HTTP', async (resource) => {
		const ctx = context(resource);
		ctx.getCredentials.mockRejectedValue(new Error('Credential unavailable'));
		await expect(new CalDav().execute.call(ctx as any)).rejects.toThrow('Credential unavailable');
		expect(ctx.helpers.httpRequest).not.toHaveBeenCalled();
		expect(ctx.helpers.httpRequestWithAuthentication).not.toHaveBeenCalled();
	});
	it.each(['calendar', 'event', 'icsFeed'])('rejects an unselected credential for %s before HTTP', async (resource) => {
		const ctx = context(resource);
		await expect(new CalDav().execute.call(ctx as any)).rejects.toThrow(
			resource === 'icsFeed' ? 'ICS Feed API credential is required' : 'CalDAV API credential is required',
		);
		expect(ctx.getCredentials.mock.calls).toEqual([[resource === 'icsFeed' ? 'icsFeedApi' : 'calDavApi']]);
		expect(ctx.helpers.httpRequest).not.toHaveBeenCalled();
		expect(ctx.helpers.httpRequestWithAuthentication).not.toHaveBeenCalled();
	});
});

describe('calendar loadOptions credential boundary', () => {
	it('requires CalDAV credentials before discovery', async () => {
		const ctx = context('event');
		await expect(new CalDav().methods.loadOptions.getCalendars.call(ctx as any)).rejects.toThrow('CalDAV API credential is required');
		expect(ctx.getCredentials.mock.calls).toEqual([['calDavApi']]);
		expect(ctx.helpers.httpRequestWithAuthentication).not.toHaveBeenCalled();
	});

	it('does not read CalDAV credentials if a stale dropdown runs for an ICS feed', async () => {
		const ctx = context('icsFeed');
		expect(await new CalDav().methods.loadOptions.getCalendars.call(ctx as any)).toEqual([]);
		expect(ctx.getCredentials).not.toHaveBeenCalled();
		expect(ctx.helpers.httpRequestWithAuthentication).not.toHaveBeenCalled();
		expect(ctx.helpers.httpRequest).not.toHaveBeenCalled();
	});
});

describe('issue #4 credential selection metadata', () => {
	it('leaves credential selection independent of resource in the editor', () => {
		expect(new CalDav().description.credentials).toEqual([
			{ name: 'calDavApi', required: false },
			{ name: 'icsFeedApi', required: false },
		]);
	});
});
