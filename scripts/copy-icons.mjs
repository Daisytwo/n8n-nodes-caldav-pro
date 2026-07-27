/**
 * Copy node icons into the build output.
 *
 * Replaces a gulp task that did nothing but this. gulp 4 is end-of-life and
 * dragged in a large transitive tree (gulp-cli, liftoff, matchdep, chokidar,
 * micromatch) for a single file copy.
 *
 * Mirrors the previous behaviour exactly: everything matching *.png / *.svg
 * under nodes/ is copied to dist/nodes/, preserving the directory structure.
 */
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'nodes');
const target = join(root, 'dist', 'nodes');
const ICON = /\.(png|svg)$/i;

async function* iconsIn(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const full = join(directory, entry.name);
		if (entry.isDirectory()) yield* iconsIn(full);
		else if (ICON.test(entry.name)) yield full;
	}
}

let copied = 0;
for await (const icon of iconsIn(source)) {
	const destination = join(target, relative(source, icon));
	await mkdir(dirname(destination), { recursive: true });
	await copyFile(icon, destination);
	copied++;
}
console.log(`copied ${copied} icon${copied === 1 ? '' : 's'} to dist/nodes`);
