import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { INodeProperties } from 'n8n-workflow';
import { CalDav } from '../nodes/CalDav/CalDav.node';
import { CalDavApi } from '../credentials/CalDavApi.credentials';

/** Flatten collections so nested fields (Additional Fields → Timezone) count too. */
function collectProperties(properties = new CalDav().description.properties): INodeProperties[] {
	return properties.flatMap((property) => [
		property,
		...collectProperties((property.options ?? []) as INodeProperties[]),
	]);
}

/**
 * Documentation assertions, not behaviour: these pin the two claims that were
 * wrong — that a 403 proves authentication worked, and that an agent picks the
 * resource and operation itself — so a rewrite cannot quietly restore them.
 */
describe('CalDAV credential test messages', () => {
	const rules = new CalDavApi().test.rules!;
	const messageFor = (value: number) => {
		const rule = rules.find(
			(r) => r.type === 'responseCode' && (r.properties as { value: number }).value === value,
		);
		return (rule!.properties as { message: string }).message;
	};

	it('does not claim that a 403 proves authentication succeeded', () => {
		const message = messageFor(403);
		expect(message).not.toContain('authentication succeeded');
		expect(message).toMatch(/credential.*permissions/i);
	});

	it('explains a 401 without pointing at a provider console URL', () => {
		const message = messageFor(401);
		expect(message).toMatch(/username/i);
		expect(message).not.toMatch(/https?:\/\//);
	});
});

describe('README AI agent guidance', () => {
	const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
	const section = readme.split('## AI Agent Usage')[1].split('\n## ')[0];

	it('documents fixed tool actions rather than AI-selected resource and operation', () => {
		expect(section).toContain('Resource and Operation must remain fixed');
		expect(section).toContain('separate tool');
		expect(section).toContain('$fromAI');
	});

	it('no longer describes the agent filling resource, operation and calendar itself', () => {
		expect(section).not.toContain('first one returned by getCalendars');
		expect(section).not.toContain('The agent will populate:');
		expect(readme).not.toContain('call it cold');
	});

	it('describes routing fields that really are expression-proof', () => {
		expect(section).toContain('noDataExpression');
		const routing = collectProperties().filter((p) => ['resource', 'operation'].includes(p.name));
		expect(routing.length).toBeGreaterThan(0);
		for (const property of routing) expect(property.noDataExpression).toBe(true);
	});

	it('only names parameters the node actually has', () => {
		const displayNames = new Set(collectProperties().map((p) => p.displayName));
		for (const label of ['Time Min', 'Time Max', 'Summary', 'Start', 'End']) {
			expect(section).toContain(label);
			expect(displayNames).toContain(label);
		}
	});
});
