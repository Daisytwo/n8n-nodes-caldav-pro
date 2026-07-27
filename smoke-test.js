/**
 * End-to-end smoke test against a real CalDAV server.
 *
 * Covers the behaviour that unit tests can only approximate with fakes:
 * discovery, iCalendar round-tripping through a real store, the read-modify-
 * write update, locating an event whose filename is not its UID, and server
 * handling of recurring series.
 *
 * Credentials come from the environment so nothing personal lives in the repo:
 *   $env:CALDAV_SERVER="https://sync.infomaniak.com/"
 *   $env:CALDAV_USERNAME="abc12345"
 *   $env:CALDAV_PASSWORD="your-app-password"
 *   node smoke-test.js
 *
 * Every object it creates is registered for cleanup and removed in a finally
 * block, so a failure part-way through does not strand events in a real
 * calendar. Run `npm run smoke:dryrun` first to exercise the script offline.
 */
const https = require('https');
const { URL } = require('url');
const { randomUUID } = require('crypto');
const {
	discoverCalendars,
	buildICalEvent,
	patchICalEvent,
	buildTimeRangeReport,
	parseCalendarQueryResponse,
	parseICalEvent,
	resolveEventUrl,
	seriesRecurrenceRule,
	eventMatchesText,
} = require('./dist/nodes/CalDav/GenericFunctions');

/**
 * Load credentials from a gitignored .env next to this file, if present.
 *
 * Keeps the password out of shell history and off the command line. Values
 * already present in the environment always win, so an explicit
 * CALDAV_PASSWORD=... prefix still overrides the file.
 */
function loadDotEnv() {
	const fs = require('fs');
	const path = require('path');
	const file = path.join(__dirname, '.env');
	if (!fs.existsSync(file)) return;
	for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
		const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!match) continue;
		const [, key, rawValue] = match;
		let value = rawValue.trim();
		if (/^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);
		if (!(key in process.env)) process.env[key] = value;
	}
}
loadDotEnv();

const SERVER = process.env.CALDAV_SERVER || 'https://sync.infomaniak.com/';
const USERNAME = process.env.CALDAV_USERNAME;
const PASSWORD = process.env.CALDAV_PASSWORD;

if (!USERNAME || !PASSWORD) {
	console.error('Set CALDAV_USERNAME and CALDAV_PASSWORD env vars first.');
	process.exit(1);
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
				res.on('data', (c) => (data += c));
				res.on('end', () => resolve({ statusCode: res.statusCode, body: data, headers: res.headers }));
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
	logger: { debug: (m) => process.env.VERBOSE && console.log(`  [debug] ${m}`) },
	helpers: {
		async httpRequestWithAuthentication(_t, opts) {
			return rawRequest(opts.method, opts.url, opts.body, opts.headers || {});
		},
	},
	async getCredentials() {
		return { defaultCalendar: '' };
	},
};

/* ─────────────── bookkeeping ─────────────── */

/** Every resource we created, so the finally block can remove them all. */
const created = new Set();
const failures = [];
const notes = [];

async function put(url, ics, headers) {
	const resp = await rawRequest('PUT', url, ics, {
		'Content-Type': 'text/calendar; charset=utf-8',
		...headers,
	});
	if (resp.statusCode < 300) created.add(url);
	return resp;
}

async function remove(url, headers) {
	const resp = await rawRequest('DELETE', url, undefined, headers);
	if (resp.statusCode < 300 || resp.statusCode === 404) created.delete(url);
	return resp;
}

async function report(calendarUrl, from, to) {
	const resp = await rawRequest(
		'REPORT',
		calendarUrl,
		buildTimeRangeReport(from.toISOString(), to.toISOString()),
		{ Depth: '1' },
	);
	return parseCalendarQueryResponse(resp.body, calendarUrl, SERVER, from, to);
}

/** Ask the server whether this account may write to a collection. */
async function isWritable(calendarUrl) {
	const resp = await rawRequest(
		'PROPFIND',
		calendarUrl,
		'<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-privilege-set/></d:prop></d:propfind>',
		{ Depth: '0' },
	);
	if (resp.statusCode >= 400) return false;
	const privileges = [...resp.body.matchAll(/<[^>]*privilege>\s*<[^>]*?([a-z-]+)\s*\/>/gi)].map((m) => m[1]);
	return privileges.some((p) => p === 'write' || p === 'write-content' || p === 'all');
}

function check(label, condition, detail) {
	if (condition) {
		console.log(`    ✓ ${label}`);
	} else {
		failures.push(label);
		console.log(`    ✗ ${label}${detail ? ` — ${detail}` : ''}`);
	}
}

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
/** iCalendar stores whole seconds; drop milliseconds before comparing. */
const toSecond = (d) => new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString();

/* ─────────────── the test ─────────────── */

async function main() {
	console.log('═══ CalDAV smoke test ═══');
	console.log(`  server: ${SERVER}`);
	console.log(`  host timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}\n`);

	const calendars = await discoverCalendars.call(fakeCtx, SERVER, USERNAME);
	if (!calendars.length) throw new Error('No calendars discovered');

	// Shared calendars and subscribed feeds are commonly read-only. Writing to
	// one fails with 403, so pick targets by privilege rather than by position.
	const writable = [];
	for (const calendar of calendars) {
		const can = await isWritable(calendar.url);
		console.log(`  ${can ? 'rw' : 'ro'}  ${calendar.displayName}`);
		if (can) writable.push(calendar);
	}
	if (!writable.length) throw new Error('No writable calendar available');

	// CALDAV_TEST_CALENDARS lets you point the test at throwaway calendars
	// instead of whichever writable one happens to come first — this script
	// creates, moves, and deletes events, so it should not run loose in a
	// calendar you actually use.
	const preferred = (process.env.CALDAV_TEST_CALENDARS || '')
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	let chosen = writable;
	if (preferred.length) {
		chosen = preferred
			.map((want) => writable.find((c) => c.displayName.toLowerCase().includes(want)))
			.filter(Boolean);
		const missing = preferred.filter(
			(want) => !writable.some((c) => c.displayName.toLowerCase().includes(want)),
		);
		if (missing.length) {
			throw new Error(
				`CALDAV_TEST_CALENDARS names no writable calendar for: ${missing.join(', ')}. ` +
					`Writable: ${writable.map((c) => c.displayName).join(', ') || '(none)'}`,
			);
		}
	}

	const source = chosen[0];
	const target = chosen[1];
	const sUrl = source.url.endsWith('/') ? source.url : source.url + '/';
	const tUrl = target ? (target.url.endsWith('/') ? target.url : target.url + '/') : null;
	console.log(`\n  source: ${source.displayName}`);
	console.log(`  target: ${target ? target.displayName : '(none — Move will be skipped)'}`);
	console.log('  (the test removes everything it creates)\n');

	const now = new Date();
	const tag = randomUUID().slice(0, 8);

	/* [1] Create — and confirm the instant survives the round trip. */
	console.log('[1] Create with an explicit timezone');
	const uid = randomUUID();
	const start = new Date(now.getTime() + 60 * MINUTE);
	const end = new Date(now.getTime() + 90 * MINUTE);
	const seedUrl = `${sUrl}${encodeURIComponent(uid)}.ics`;
	const seedResp = await put(
		seedUrl,
		buildICalEvent({
			uid,
			summary: `Smoke Test Event - findme-${tag}`,
			start: start.toISOString(),
			end: end.toISOString(),
			description: 'Created by smoke-test.js',
			location: 'Room 1',
			timezone: 'Europe/Berlin',
		}),
		{ 'If-None-Match': '*' },
	);
	check(`PUT accepted (${seedResp.statusCode})`, seedResp.statusCode < 300, seedResp.body.slice(0, 200));
	const readBack = await report(sUrl, new Date(now.getTime() - MINUTE), new Date(now.getTime() + DAY));
	const seeded = readBack.find((e) => e.uid === uid);
	check('event is readable', !!seeded);
	// The headline fix: a TZID event must come back at the instant we asked for,
	// regardless of this machine's timezone or the server's storage format.
	check(
		'start round-trips to the correct instant',
		seeded && seeded.start === toSecond(start),
		seeded ? `expected ${toSecond(start)}, got ${seeded.start}` : undefined,
	);
	check('timezone reported', seeded && !!seeded.timezone, seeded && `timezone=${seeded.timezone}`);

	/* [2] Get Next / Search. */
	console.log('\n[2] Get Next and Search');
	const upcoming = (await report(sUrl, now, new Date(now.getTime() + 7 * DAY)))
		.filter((e) => e.start && new Date(e.start) >= now)
		.sort((a, b) => String(a.start).localeCompare(String(b.start)));
	check('seeded event appears among upcoming', upcoming.some((e) => e.uid === uid));
	const hits = (await report(sUrl, now, new Date(now.getTime() + DAY))).filter((e) =>
		eventMatchesText(e, `findme-${tag}`),
	);
	check('keyword search finds exactly one', hits.length === 1, `got ${hits.length}`);

	/* [3] Update — the read-modify-write patch. */
	console.log('\n[3] Update preserves fields it was not given');
	const beforeResp = await rawRequest('GET', seedUrl, undefined, { Accept: 'text/calendar' });
	const beforeEtag = (beforeResp.headers.etag || '').replace(/"/g, '');
	check('server returned an ETag', !!beforeEtag);
	// Add a property the node does not model, to prove a patch keeps it.
	const withCategory = beforeResp.body.replace('SUMMARY:', 'CATEGORIES:smoke-test\r\nSUMMARY:');
	await put(seedUrl, withCategory, beforeEtag ? { 'If-Match': `"${beforeEtag}"` } : undefined);

	const current = await rawRequest('GET', seedUrl, undefined, { Accept: 'text/calendar' });
	const currentEtag = (current.headers.etag || '').replace(/"/g, '');
	const newStart = new Date(now.getTime() + 120 * MINUTE);
	const newEnd = new Date(now.getTime() + 150 * MINUTE);
	const patched = patchICalEvent(current.body, {
		summary: `Smoke Test Event - updated-${tag}`,
		start: newStart.toISOString(),
		end: newEnd.toISOString(),
	});
	const updateResp = await put(seedUrl, patched, currentEtag ? { 'If-Match': `"${currentEtag}"` } : undefined);
	check(`update accepted (${updateResp.statusCode})`, updateResp.statusCode < 300, updateResp.body.slice(0, 200));

	const after = await rawRequest('GET', seedUrl, undefined, { Accept: 'text/calendar' });
	const afterEvent = parseICalEvent(after.body, seedUrl);
	check('summary changed', afterEvent && afterEvent.summary.includes(`updated-${tag}`));
	check('start changed', afterEvent && afterEvent.start === toSecond(newStart), afterEvent && afterEvent.start);
	check('description preserved', afterEvent && afterEvent.description === 'Created by smoke-test.js');
	check('location preserved', afterEvent && afterEvent.location === 'Room 1');
	check('unmodelled CATEGORIES preserved', after.body.includes('CATEGORIES:smoke-test'));
	check('SEQUENCE incremented', /SEQUENCE:[1-9]/.test(after.body), 'no SEQUENCE bump found');

	// A stale ETag must be refused rather than silently overwriting.
	if (beforeEtag && currentEtag && beforeEtag !== currentEtag) {
		const stale = await rawRequest('PUT', seedUrl, patched, {
			'Content-Type': 'text/calendar; charset=utf-8',
			'If-Match': `"${beforeEtag}"`,
		});
		check('stale If-Match is rejected with 412', stale.statusCode === 412, `got ${stale.statusCode}`);
	} else {
		notes.push('If-Match conflict not exercised: server reused the ETag across writes.');
	}

	/* [4] UID resolution — the filename is deliberately not the UID. */
	console.log('\n[4] Locate an event whose filename is not its UID');
	const foreignUid = `smoke-foreign-${tag}`;
	const foreignUrl = `${sUrl}${randomUUID()}-not-the-uid.ics`;
	await put(
		foreignUrl,
		buildICalEvent({
			uid: foreignUid,
			summary: `Smoke Test Event - foreign-${tag}`,
			start: new Date(now.getTime() + 3 * 60 * MINUTE).toISOString(),
			end: new Date(now.getTime() + 4 * 60 * MINUTE).toISOString(),
		}),
		{ 'If-None-Match': '*' },
	);
	const resolved = await resolveEventUrl.call(fakeCtx, sUrl, foreignUid, undefined, SERVER);
	const conventional = `${sUrl}${encodeURIComponent(foreignUid)}.ics`;
	if (resolved === foreignUrl) {
		check('UID resolved to the real resource', true);
	} else if (resolved === conventional) {
		check('UID resolved to the real resource', false, 'fell back to <uid>.ics');
		notes.push(
			'This server did not answer the UID prop-filter query. Events created outside ' +
				'this node cannot be addressed by UID here — pass the Event URL instead.',
		);
	} else {
		check('UID resolved to the real resource', false, `unexpected: ${resolved}`);
	}
	const explicit = await resolveEventUrl.call(fakeCtx, sUrl, '', foreignUrl, SERVER);
	check('explicit URL is passed through', explicit === foreignUrl, explicit);

	/* [5] Recurring series. */
	console.log('\n[5] Recurring series expansion');
	const seriesUid = `smoke-series-${tag}`;
	const seriesStart = new Date(now.getTime() + DAY);
	const seriesUrl = `${sUrl}${encodeURIComponent(seriesUid)}.ics`;
	await put(
		seriesUrl,
		buildICalEvent({
			uid: seriesUid,
			summary: `Smoke Test Event - series-${tag}`,
			start: seriesStart.toISOString(),
			end: new Date(seriesStart.getTime() + 30 * MINUTE).toISOString(),
			timezone: 'Europe/Berlin',
			rrule: 'FREQ=WEEKLY;COUNT=4',
		}),
		{ 'If-None-Match': '*' },
	);
	const occurrences = (await report(sUrl, now, new Date(now.getTime() + 40 * DAY)))
		.filter((e) => e.uid === seriesUid)
		.sort((a, b) => String(a.start).localeCompare(String(b.start)));
	check('four occurrences returned', occurrences.length === 4, `got ${occurrences.length}`);
	check(
		'first occurrence is the series start',
		occurrences[0] && occurrences[0].start === toSecond(seriesStart),
		occurrences[0] && occurrences[0].start,
	);
	check(
		'occurrences are one week apart',
		occurrences.length === 4 &&
			occurrences.every(
				(e, i) =>
					i === 0 ||
					Math.abs(new Date(e.start) - new Date(occurrences[i - 1].start) - 7 * DAY) <= 60 * MINUTE,
			),
		occurrences.map((e) => e.start).join(', '),
	);
	check(
		'each occurrence carries a distinct recurrenceId',
		new Set(occurrences.map((e) => e.recurrenceId)).size === occurrences.length,
	);
	check('all occurrences share the series UID', occurrences.every((e) => e.uid === seriesUid));

	// The guard that stops Delete/Update from wiping a whole series reads the
	// rule back off the stored object. Servers may rewrite the iCalendar they
	// were given, so this has to hold against what the server actually returns,
	// not against what we sent.
	const storedSeries = await rawRequest('GET', seriesUrl, undefined, { Accept: 'text/calendar' });
	const detectedRule = seriesRecurrenceRule(storedSeries.body);
	check(
		'recurrence rule is detectable on the stored object',
		!!detectedRule && /FREQ=WEEKLY/i.test(detectedRule),
		`detected: ${detectedRule ?? 'none'}`,
	);
	check(
		'a plain event is not mistaken for a series',
		seriesRecurrenceRule((await rawRequest('GET', seedUrl, undefined, { Accept: 'text/calendar' })).body) ===
			undefined,
	);

	/* [6] Move. */
	console.log('\n[6] Move between calendars');
	if (!tUrl) {
		notes.push(
			`Move was not exercised: only one writable calendar ("${source.displayName}") is ` +
				'available on this account. Every other calendar is read-only.',
		);
		console.log('    – skipped, no second writable calendar');
	} else {
		const moveSource = await rawRequest('GET', seedUrl, undefined, { Accept: 'text/calendar' });
		const moveEtag = (moveSource.headers.etag || '').replace(/"/g, '');
		const movedUrl = `${tUrl}${encodeURIComponent(uid)}.ics`;
		const moveResp = await put(movedUrl, moveSource.body, { 'If-None-Match': '*' });
		check(`copy to target accepted (${moveResp.statusCode})`, moveResp.statusCode < 300, moveResp.body.slice(0, 120));
		// Only remove the original once the copy is known to exist. Deleting
		// unconditionally destroys the event when the target rejects the write.
		if (moveResp.statusCode < 300) {
			const delResp = await remove(seedUrl, moveEtag ? { 'If-Match': `"${moveEtag}"` } : undefined);
			check(`source removed (${delResp.statusCode})`, delResp.statusCode < 300);
			const onTarget = (await report(tUrl, now, new Date(now.getTime() + 7 * DAY))).some((e) => e.uid === uid);
			const onSource = (await report(sUrl, now, new Date(now.getTime() + 7 * DAY))).some((e) => e.uid === uid);
			check('present on target', onTarget);
			check('gone from source', !onSource);
		} else {
			console.log('    – source kept, copy did not succeed');
		}
	}
}

main()
	.catch((err) => {
		failures.push(`fatal: ${err.message}`);
		console.error(`\n✗ aborted: ${err.stack || err.message}`);
	})
	.finally(async () => {
		console.log('\n[cleanup]');
		for (const url of [...created]) {
			try {
				const resp = await remove(url);
				console.log(`    ${resp.statusCode} ${url.split('/').pop()}`);
			} catch (err) {
				console.log(`    FAILED ${url} — ${err.message}`);
			}
		}
		if (created.size) {
			console.log(`\n⚠  ${created.size} object(s) could NOT be removed — delete them manually:`);
			for (const url of created) console.log(`     ${url}`);
		}

		for (const note of notes) console.log(`\nnote: ${note}`);

		if (failures.length) {
			console.error(`\n═══ ${failures.length} CHECK(S) FAILED ═══`);
			for (const f of failures) console.error(`  ✗ ${f}`);
			process.exitCode = 1;
		} else {
			console.log('\n═══ ALL SMOKE TESTS PASSED ═══');
		}
	});
