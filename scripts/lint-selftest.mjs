/**
 * Assert that every eslint-plugin-n8n-nodes-base preset is actually wired up.
 *
 * A misconfigured flat config can leave rules "configured" but unresolvable,
 * in which case `eslint` exits 0 while checking nothing — which is worse than
 * having no linter, because it looks like it passed. This feeds one deliberate
 * violation to each preset and fails if it is not reported.
 */
import { ESLint } from 'eslint';

const cases = [
	{
		preset: 'nodes',
		filePath: 'nodes/CalDav/Probe.ts',
		expect: 'n8n-nodes-base/node-param-description-miscased-url',
		code: `import type { INodeProperties } from 'n8n-workflow';
export const probe: INodeProperties[] = [
	{
		displayName: 'Probe',
		name: 'probe',
		type: 'string',
		default: '',
		description: 'Paste the url of the event here',
	},
];
`,
	},
	{
		preset: 'credentials',
		filePath: 'credentials/Probe.credentials.ts',
		expect: 'n8n-nodes-base/cred-class-field-display-name-miscased',
		code: `import type { ICredentialType, INodeProperties } from 'n8n-workflow';
export class Probe implements ICredentialType {
	name = 'probe';
	displayName = 'probe api';
	properties: INodeProperties[] = [];
}
`,
	},
];
// The plugin's `community` preset is not covered here because it is not
// enabled — see the note in eslint.config.mjs. Add a case here if the upstream
// visitor bug is ever fixed and the preset is switched back on.

// Rules that need type information can't run on a virtual file, so type-aware
// parsing is disabled for the probe; the rules under test are all syntactic.
const eslint = new ESLint({
	overrideConfigFile: 'eslint.config.mjs',
	overrideConfig: { languageOptions: { parserOptions: { project: null } } },
});

let failed = 0;
for (const testCase of cases) {
	const [result] = await eslint.lintText(testCase.code, { filePath: testCase.filePath });
	const fired = (result?.messages ?? []).map((m) => m.ruleId);
	if (fired.includes(testCase.expect)) {
		console.log(`  ok   ${testCase.preset.padEnd(12)} ${testCase.expect}`);
	} else {
		failed++;
		console.error(`  FAIL ${testCase.preset.padEnd(12)} expected ${testCase.expect}`);
		console.error(`       reported instead: ${fired.length ? fired.join(', ') : '(nothing)'}`);
	}
}

if (failed) {
	console.error(`\n${failed} preset(s) are not enforcing anything — check eslint.config.mjs.`);
	process.exit(1);
}
console.log('\nall n8n-nodes-base presets are enforcing.');
