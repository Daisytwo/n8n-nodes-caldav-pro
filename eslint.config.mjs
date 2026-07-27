import tsParser from '@typescript-eslint/parser';
import n8nPlugin from 'eslint-plugin-n8n-nodes-base';

/**
 * ESLint 9 flat config.
 *
 * eslint-plugin-n8n-nodes-base ships only eslintrc-style shareable configs, so
 * its presets are read as plain rule maps and the plugin is registered by name.
 * Bridging them with FlatCompat instead registered the plugin under numeric
 * keys, which left every rule configured but unresolvable — linting passed
 * while checking nothing.
 *
 * `npm run lint:selftest` guards against that failure mode returning: it feeds
 * a deliberate violation to each preset and fails if it goes unreported.
 *
 * The plugin's third preset, `community` (19 rules against package.json), is
 * deliberately absent. Its rules visit `ObjectExpression`, but the JSON parser
 * emits `JSONObjectExpression`, so they never match. Verified inert under both
 * ESLint 8 and 9 and under plugin 1.16.6 and 1.16.7 — an upstream bug, not a
 * local misconfiguration. Config that silently checks nothing is worse than no
 * config, so it is left out until the plugin fixes it.
 */
const plugins = { 'n8n-nodes-base': n8nPlugin };

const typescript = {
	parser: tsParser,
	parserOptions: { project: ['./tsconfig.json'], sourceType: 'module' },
};

export default [
	{
		ignores: ['dist/**', 'node_modules/**', 'scripts/**', 'test/**', '*.js', '*.mjs'],
	},

	// Credential classes.
	{
		files: ['credentials/**/*.ts'],
		plugins,
		languageOptions: typescript,
		rules: {
			...n8nPlugin.configs.credentials.rules,
			// This rule camelCases the URL (destroying it) and contradicts
			// cred-class-field-documentation-url-not-http-url. We publish a
			// full HTTPS URL as documentation, so disable the casing check.
			'n8n-nodes-base/cred-class-field-documentation-url-miscased': 'off',
		},
	},

	// Node classes and their description files.
	{
		files: ['nodes/**/*.ts'],
		plugins,
		languageOptions: typescript,
		rules: n8nPlugin.configs.nodes.rules,
	},
];
