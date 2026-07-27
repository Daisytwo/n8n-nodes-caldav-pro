/**
 * Assert the published tarball contains what it should and nothing it should not.
 *
 * Both failure modes here have happened: a 64 kB incremental build cache shipped
 * with every release because package.json "files" takes precedence over
 * .npmignore, and the package declared MIT while shipping no licence text.
 * Neither breaks a test, so only a check like this catches them.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
	encoding: 'utf8',
	cwd: new URL('..', import.meta.url),
	shell: process.platform === 'win32',
});
const files = JSON.parse(raw)[0].files.map((f) => f.path.replace(/\\/g, '/'));

const problems = [];

// Everything the n8n manifest points at has to be in the tarball, or the node
// silently fails to register after install.
for (const declared of [...(pkg.n8n?.nodes ?? []), ...(pkg.n8n?.credentials ?? [])]) {
	if (!files.includes(declared)) problems.push(`n8n manifest points at a missing file: ${declared}`);
}

const required = ['package.json', 'LICENSE', 'README.md', 'CHANGELOG.md'];
for (const name of required) {
	if (!files.includes(name)) problems.push(`missing from package: ${name}`);
}

// The node icon is loaded by filename at runtime, not imported, so nothing else
// would notice its absence.
if (!files.some((f) => /^dist\/nodes\/.+\.(svg|png)$/.test(f))) {
	problems.push('no node icon in dist/nodes');
}

const forbidden = [
	[/\.tsbuildinfo$/, 'incremental build cache'],
	[/^test\//, 'test sources'],
	[/^scripts\//, 'dev scripts'],
	[/^\.env/, 'environment file'],
	[/^(?!dist\/).*\.ts$/, 'TypeScript source outside dist'],
	[/smoke-test\.js$/, 'smoke test'],
];
for (const [pattern, label] of forbidden) {
	const hits = files.filter((f) => pattern.test(f));
	if (hits.length) problems.push(`${label} should not ship: ${hits.slice(0, 3).join(', ')}`);
}

console.log(`${files.length} files, ${pkg.name}@${pkg.version}`);
if (problems.length) {
	console.error('\npackage contents are wrong:');
	for (const p of problems) console.error(`  - ${p}`);
	process.exit(1);
}
console.log('package contents look right.');
