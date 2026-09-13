import { describe, expect, it } from 'vitest';
import { CalDav } from '../nodes/CalDav/CalDav.node';

/**
 * The notices are the replacement for resource-gated credentials: they tell the
 * user which credential the selected resource reads without letting n8n treat
 * "resource" as an authentication switch (issue #4). A notice that showed for
 * two resources at once, or that gated the credentials again, would undo that.
 */
describe('resource-specific credential guidance', () => {
	const resources = ['calendar', 'event', 'icsFeed'];

	it.each(resources)('shows exactly one relevant notice for %s', (resource) => {
		const notices = new CalDav().description.properties.filter(
			(p) => p.type === 'notice' && p.displayOptions?.show?.resource?.includes(resource),
		);
		expect(notices).toHaveLength(1);
		expect(notices[0].displayName).toContain(resource === 'icsFeed' ? 'ICS Feed API' : 'CalDAV API');
		expect(notices[0].displayName).toContain('can be left empty');
	});

	it('scopes every notice to a resource so none is shown unconditionally', () => {
		const notices = new CalDav().description.properties.filter((p) => p.type === 'notice');
		expect(notices.length).toBeGreaterThan(0);
		for (const notice of notices) {
			expect(notice.displayOptions?.show?.resource).toBeDefined();
		}
		const covered = notices.flatMap((n) => n.displayOptions!.show!.resource as string[]);
		expect([...covered].sort()).toEqual([...resources].sort());
	});

	it('keeps the credentials themselves ungated', () => {
		for (const credential of new CalDav().description.credentials!) {
			expect(credential).not.toHaveProperty('displayOptions');
			expect(credential.required).toBe(false);
		}
	});
});
