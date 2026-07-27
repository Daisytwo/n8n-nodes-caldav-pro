/**
 * Run smoke-test.js unchanged against an in-memory CalDAV server.
 *
 * This proves the script still works with the current module exports and
 * request flow. It does NOT replace a run against a real server: it cannot
 * reproduce Infomaniak's discovery quirks, redirects, auth, or ETag semantics.
 * Its job is to catch script-level breakage before the live run, so a failure
 * does not leave stray events behind in a real calendar.
 */
import { createRequire } from 'node:module';
import https from 'node:https';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);

const HOME = '/calendars/tester/';
const CALENDARS = [
	{ href: '/calendars/tester/work/', name: 'Work' },
	{ href: '/calendars/tester/private/', name: 'Private' },
];

/** path -> { body, etag } */
const store = new Map();
let etagSeq = 0;
const log = [];

const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function multistatus(inner) {
	return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/">${inner}</d:multistatus>`;
}

function propResponse(href, propXml) {
	return `<d:response><d:href>${href}</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop>${propXml}</d:prop></d:propstat></d:response>`;
}

/** Extract DTSTART as an epoch so the REPORT can honour the time-range. */
function startOf(ics) {
	const m = /DTSTART[^:\r\n]*:(\d{8})T?(\d{6})?Z?/.exec(ics);
	if (!m) return 0;
	const [, d, t = '000000'] = m;
	return Date.UTC(
		+d.slice(0, 4),
		+d.slice(4, 6) - 1,
		+d.slice(6, 8),
		+t.slice(0, 2),
		+t.slice(2, 4),
		+t.slice(4, 6),
	);
}

function handle(method, path, body, headers = {}) {
	log.push(`${method} ${path}`);

	// Header names arrive with the casing the caller used.
	const header = (name) => {
		const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
		return key ? String(headers[key]) : undefined;
	};

	if (method === 'PROPFIND') {
		if (body.includes('current-user-privilege-set')) {
			// Mirror a real account: one writable calendar, the rest read-only.
			const writable = path === CALENDARS[0].href || path === CALENDARS[1].href;
			const privilege = (p) => `<d:privilege><d:${p}/></d:privilege>`;
			const set = writable
				? ['read', 'write', 'write-content', 'bind', 'unbind'].map(privilege).join('')
				: ['read', 'read-acl', 'read-current-user-privilege-set'].map(privilege).join('');
			return [207, multistatus(propResponse(path, `<d:current-user-privilege-set>${set}</d:current-user-privilege-set>`))];
		}
		if (body.includes('current-user-principal')) {
			return [207, multistatus(propResponse('/', '<d:current-user-principal><d:href>/principals/tester/</d:href></d:current-user-principal>'))];
		}
		if (body.includes('calendar-home-set')) {
			return [207, multistatus(propResponse('/principals/tester/', `<c:calendar-home-set><d:href>${HOME}</d:href></c:calendar-home-set>`))];
		}
		// Collection listing. The home itself is returned as a plain collection,
		// as real servers do, to exercise the resourcetype filter.
		const entries = [
			propResponse(HOME, '<d:resourcetype><d:collection/></d:resourcetype><d:displayname>Home</d:displayname>'),
			...CALENDARS.map((c) =>
				propResponse(c.href, `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${c.name}</d:displayname>`),
			),
		];
		return [207, multistatus(entries.join(''))];
	}

	if (method === 'PUT') {
		const existing = store.get(path);
		if (header('if-none-match') === '*' && existing) return [412, 'already exists'];
		const ifMatch = header('if-match');
		if (ifMatch && (!existing || ifMatch.replace(/"/g, '') !== existing.etag.replace(/"/g, ''))) {
			return [412, 'etag mismatch'];
		}
		const etag = `"etag-${++etagSeq}"`;
		store.set(path, { body, etag });
		return [existing ? 204 : 201, '', { etag }];
	}

	if (method === 'GET') {
		const item = store.get(path);
		if (!item) return [404, 'not found'];
		return [200, item.body, { etag: item.etag }];
	}

	if (method === 'DELETE') {
		if (!store.has(path)) return [404, 'not found'];
		store.delete(path);
		return [204, ''];
	}

	if (method === 'REPORT') {
		// UID lookup: return the href of whichever resource carries that UID,
		// which is how a real server answers a prop-filter query.
		const uidFilter = /<c:prop-filter name="UID">\s*<c:text-match[^>]*>([^<]*)</.exec(body);
		if (uidFilter) {
			const wanted = uidFilter[1];
			const match = [...store.entries()].find(
				([p, item]) => p.startsWith(path) && new RegExp(`^UID:${wanted}\\s*$`, 'm').test(item.body),
			);
			return [
				207,
				multistatus(match ? propResponse(match[0], `<d:getetag>${match[1].etag}</d:getetag>`) : ''),
			];
		}

		const range = /<c:time-range start="(\d{8}T\d{6}Z)" end="(\d{8}T\d{6}Z)"/.exec(body);
		const toMs = (s) =>
			Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));
		const from = range ? toMs(range[1]) : -Infinity;
		const to = range ? toMs(range[2]) : Infinity;
		const inside = [...store.entries()].filter(([p, item]) => {
			if (!p.startsWith(path)) return false;
			const s = startOf(item.body);
			return s >= from && s < to;
		});
		return [
			207,
			multistatus(
				inside
					.map(([p, item]) =>
						propResponse(p, `<d:getetag>${item.etag}</d:getetag><c:calendar-data>${xmlEscape(item.body)}</c:calendar-data>`),
					)
					.join(''),
			),
		];
	}

	return [405, 'method not allowed'];
}

https.request = (options, callback) => {
	const req = new EventEmitter();
	let payload = '';
	req.write = (chunk) => {
		payload += chunk;
		return true;
	};
	req.end = () => {
		let status, body, headers;
		try {
			[status, body, headers = {}] = handle(options.method, options.path, payload, options.headers);
		} catch (err) {
			process.nextTick(() => req.emit('error', err));
			return;
		}
		const res = new EventEmitter();
		res.statusCode = status;
		res.headers = headers;
		process.nextTick(() => {
			callback(res);
			res.emit('data', body);
			res.emit('end');
		});
	};
	return req;
};

process.env.CALDAV_SERVER = 'https://fake.invalid/';
process.env.CALDAV_USERNAME = 'tester';
process.env.CALDAV_PASSWORD = 'not-a-real-password';

process.on('exit', (code) => {
	console.log(`\n── ${log.length} requests, ${store.size} object(s) left behind ──`);
	if (store.size) {
		console.log('LEFTOVER:', [...store.keys()].join(', '));
		if (code === 0) process.exitCode = 1;
	}
});

require('../smoke-test.js');
