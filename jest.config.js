/** @type {import('jest').Config} */
module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'node',
	roots: ['<rootDir>/test', '<rootDir>/nodes'],
	testMatch: ['**/?(*.)+(spec|test).ts'],
	moduleFileExtensions: ['ts', 'js', 'json'],
	collectCoverageFrom: [
		'nodes/**/*.ts',
		'credentials/**/*.ts',
		'!**/*.d.ts',
		'!**/node_modules/**',
	],
	coverageDirectory: 'coverage',
	testPathIgnorePatterns: ['/node_modules/', '/dist/'],
	verbose: true,
};
