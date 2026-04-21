/**
 * End-to-end test against Infomaniak CalDAV.
 * Exercises the protocol primitives from GenericFunctions.ts without pulling
 * in the n8n runtime, by faking the minimum of IExecuteFunctions that our
 * helpers actually use: helpers.httpRequestWithAuthentication, getNode(),
 * logger (optional).
 */
const https = require('https');
const { URL } = require('url');
const {
	discoverCalendarHome,
	discoverCalendars,
	buildICalEvent,
	buildTimeRangeReport,
	parseCalendarQueryResponse,
} = require('./dist/nodes/CalDav/GenericFunctions');
const { randomUUID } = require('crypto');

// Credentials are read from environment variables so no secrets land in git.
//
// Usage (bash):
//   export CALDAV_SERVER=https://sync.infomaniak.com/
//   export CALDAV_USERNAME=abc12345
//   export CALDAV_PASSWORD=your-app-password
//   node e2e-test.js
//
// Usage (PowerShell):
//   $env:CALDAV_SERVER="https://sync.infomaniak.com/"
//   $env:CALDAV_USERNAME="abc12345"
//   $env:CALDAV_PASSWORD="your-app-password"
//   node e2e-test.js
const SERVER = process.env.CALDAV_SERVER || 'https://sync.infomaniak.com/';
const USERNAME = process.env.CALDAV_USERNAME;
const PASSWORD = process.env.CALDAV_PASSWORD;

if (!USERNAME || !PASSWORD) {
	console.error(
		'✗ CALDAV_USERNAME and CALDAV_PASSWORD environment variables are required. See comments at the top of this file.',
	);
	process.exit(2);
}

function rawRequest(method, url, body, headers) {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const token = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
		const req = https.request(
			{
				method,
				hostname: u.hostname,
				port: u.port || 443,
				path: u.pathname + u.search,
				headers: {
					Authorization: `Basic ${token}`,
					'Content-Type': 'application/xml; charset=utf-8',
					Accept: 'application/xml, text/xml, text/calendar',
					'Content-Length': body ? Buffer.byteLength(body) : 0,
					...headers,
				},
			},
			(res) => {
				let data = '';
				res.on('data', (chunk) => (data += chunk));
				res.on('end', () =>
					resolve({ statusCode: res.statusCode, body: data, headers: res.headers }),
				);
			},
		);
		req.on('error', reject);
		if (body) req.write(body);
		req.end();
	});
}

const fakeCtx = {
	getNode() {
		return { name: 'CalDAV', type: 'n8n-nodes-base.calDav', typeVersion: 1, id: 'test' };
	},
	logger: {
		debug: (m) => console.log(`  [debug] ${m}`),
	},
	helpers: {
		async httpRequestWithAuthentication(_credType, opts) {
			const resp = await rawRequest(opts.method, opts.url, opts.body, opts.headers || {});
			return { statusCode: resp.statusCode, body: resp.body, headers: resp.headers };
		},
	},
};

async function main() {
	console.log('═══ CalDAV E2E Test against Infomaniak ═══');
	console.log(`  Server: ${SERVER}`);
	console.log(`  User:   ${USERNAME}\n`);

	// 1. Authentication smoke test via server root
	console.log('[1] Authenticating (PROPFIND /)');
	const authResp = await rawRequest(
		'PROPFIND',
		SERVER,
		`<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`,
		{ Depth: '0' },
	);
	console.log(`    → ${authResp.statusCode}`);
	if (authResp.statusCode !== 207) throw new Error(`Auth failed: ${authResp.statusCode}`);
	console.log('    ✓ Authentication OK\n');

	// 2. Calendar discovery
	console.log('[2] Discovering calendar-home-set…');
	const home = await discoverCalendarHome.call(fakeCtx, SERVER, USERNAME);
	console.log(`    → ${home}\n`);

	// 3. Calendar.getAll
	console.log('[3] Calendar > Get All');
	const calendars = await discoverCalendars.call(fakeCtx, SERVER, USERNAME);
	if (!calendars.length) throw new Error('No calendars found');
	console.log(`    Found ${calendars.length} calendar(s):`);
	calendars.forEach((c) => console.log(`      - ${c.displayName} → ${c.url}`));
	const target = calendars[0];
	console.log(`    → Using "${target.displayName}"\n`);

	// 4. Event.create
	console.log('[4] Event > Create "CalDAV Pro E2E Test"');
	const uid = randomUUID();
	const now = new Date();
	const later = new Date(now.getTime() + 60 * 60 * 1000);
	const ical = buildICalEvent({
		uid,
		summary: 'CalDAV Pro E2E Test',
		start: now.toISOString(),
		end: later.toISOString(),
		description: 'Created by n8n-nodes-caldav-pro E2E test',
	});
	const calUrl = target.url.endsWith('/') ? target.url : target.url + '/';
	const eventUrl = `${calUrl}${encodeURIComponent(uid)}.ics`;
	const putResp = await rawRequest('PUT', eventUrl, ical, {
		'Content-Type': 'text/calendar; charset=utf-8',
		'If-None-Match': '*',
	});
	console.log(`    → PUT ${putResp.statusCode}, ETag=${putResp.headers.etag || '(none)'}`);
	if (putResp.statusCode !== 201 && putResp.statusCode !== 204) {
		throw new Error(`Create failed: ${putResp.statusCode}\n${putResp.body}`);
	}
	console.log(`    ✓ Event created, UID=${uid}\n`);

	// 5. Event.getAll for today
	console.log('[5] Event > Get All for today');
	const dayStart = new Date();
	dayStart.setHours(0, 0, 0, 0);
	const dayEnd = new Date();
	dayEnd.setHours(23, 59, 59, 0);
	const reportBody = buildTimeRangeReport(dayStart.toISOString(), dayEnd.toISOString());
	const reportResp = await rawRequest('REPORT', calUrl, reportBody, { Depth: '1' });
	console.log(`    → REPORT ${reportResp.statusCode}`);
	const events = parseCalendarQueryResponse(reportResp.body, calUrl, SERVER);
	console.log(`    Found ${events.length} event(s) today`);
	const found = events.find((e) => e.uid === uid);
	if (!found) throw new Error(`Created event UID ${uid} NOT found in getAll!`);
	console.log(`    ✓ Our event is present: "${found.summary}"\n`);

	// 6. Event.delete
	console.log('[6] Event > Delete');
	const delResp = await rawRequest('DELETE', eventUrl);
	console.log(`    → DELETE ${delResp.statusCode}`);
	if (delResp.statusCode !== 204 && delResp.statusCode !== 200) {
		throw new Error(`Delete failed: ${delResp.statusCode}`);
	}
	console.log('    ✓ Event deleted\n');

	// 7. Verify it's gone
	console.log('[7] Event > Get All again (should NOT contain our UID)');
	const report2 = await rawRequest('REPORT', calUrl, reportBody, { Depth: '1' });
	const events2 = parseCalendarQueryResponse(report2.body, calUrl, SERVER);
	const stillThere = events2.find((e) => e.uid === uid);
	if (stillThere) throw new Error(`Event UID ${uid} STILL present after delete!`);
	console.log(`    ✓ Event is gone (${events2.length} event(s) remain)\n`);

	console.log('═══ ALL TESTS PASSED ═══');
}

main().catch((err) => {
	console.error('\n✗ E2E TEST FAILED');
	console.error(err);
	process.exit(1);
});
