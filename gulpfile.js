const { src, dest } = require('gulp');

function copyIcons() {
	const nodeSource = src('nodes/**/*.{png,svg}');
	const nodeDestination = dest('dist/nodes');

	const credSource = src('credentials/**/*.{png,svg}');
	const credDestination = dest('dist/credentials');

	nodeSource.pipe(nodeDestination);
	return credSource.pipe(credDestination);
}

exports['build:icons'] = copyIcons;
