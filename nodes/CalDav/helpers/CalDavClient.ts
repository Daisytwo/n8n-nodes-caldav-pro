/**
 * Minimal CalDAV client used by the nodes. Only the verbs required for the
 * offered operations are implemented:
 *   - PROPFIND (listing)
 *   - REPORT   (calendar-query / free-busy-query)
 *   - GET      (fetch a single resource)
 *   - PUT      (create / update a resource)
 *   - DELETE   (remove a resource)
 *
 * Relies on the n8n httpHelper injected via `httpRequestWithAuthentication`
 * so credentials (Basic auth) are applied consistently with other n8n nodes.
 */

import type { IDataObject, IExecuteFunctions, IHttpRequestOptions } from 'n8n-workflow';
import { assertSafePathSegment, escapeICalText, sanitizeUid } from './Utils';
import { formatUtcStamp } from './Timezone';

export interface CalDavCredentials {
	serverUrl: string;
	username: string;
	password: string;
}

export interface ResourceSummary {
	href: string;
	etag?: string;
	data?: string; // raw iCal body, present when returned in a calendar-data response
}

function ensureTrailingSlash(url: string): string {
	return url.endsWith('/') ? url : url + '/';
}

function joinUrl(baseUrl: string, relative: string): string {
	const base = ensureTrailingSlash(baseUrl);
	if (relative.startsWith('http://') || relative.startsWith('https://')) return relative;
	if (relative.startsWith('/')) {
		// relative is server-absolute; rebuild from origin
		try {
			const b = new URL(base);
			return `${b.origin}${relative}`;
		} catch {
			return base + relative.replace(/^\/+/, '');
		}
	}
	return base + relative;
}

function isXml(contentType: string | undefined): boolean {
	if (!contentType) return false;
	const ct = contentType.toLowerCase();
	return ct.includes('xml');
}

async function request(
	ctx: IExecuteFunctions,
	credentials: CalDavCredentials,
	options: {
		method: string;
		url: string;
		headers?: Record<string, string>;
		body?: string;
	},
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
	const httpOptions: IHttpRequestOptions = {
		method: options.method as IHttpRequestOptions['method'],
		url: options.url,
		headers: {
			'User-Agent': 'n8n-nodes-caldav-calendar/1.0.0',
			...options.headers,
		},
		body: options.body,
		returnFullResponse: true,
		json: false,
		// Ensure the body is sent as-is (string), not JSON-encoded
		ignoreHttpStatusErrors: true,
	};

	// Use credential-aware request so Basic auth headers are attached.
	const response = (await ctx.helpers.httpRequestWithAuthentication.call(
		ctx,
		'calDavApi',
		httpOptions,
	)) as { statusCode?: number; headers?: Record<string, string>; body: unknown };

	const status = response.statusCode ?? 0;
	const headers = response.headers ?? {};
	const rawBody = response.body;
	const bodyString =
		typeof rawBody === 'string'
			? rawBody
			: Buffer.isBuffer(rawBody)
				? rawBody.toString('utf-8')
				: rawBody !== undefined && rawBody !== null
					? JSON.stringify(rawBody)
					: '';

	return { statusCode: status, headers, body: bodyString };
}

// -----------------------------------------------------------------------------
// XML helpers
// -----------------------------------------------------------------------------

/**
 * Tiny regex-based XML extractor. Sufficient for the well-formed WebDAV / CalDAV
 * Multi-Status documents the listed servers return. We never use it on untrusted
 * markup for anything security-sensitive; it only splits `<response>` blocks and
 * picks out a handful of known text nodes.
 */
function extractResponses(xml: string): Array<{ href?: string; etag?: string; data?: string }> {
	if (!xml) return [];
	// Strip namespace prefixes to simplify matching. This is safe for read-only extraction.
	const normalised = xml.replace(/<\/?([a-zA-Z0-9]+):/g, (_m, _p) => `<${_m.startsWith('</') ? '/' : ''}`);
	const results: Array<{ href?: string; etag?: string; data?: string }> = [];
	const blockRegex = /<response\b[\s\S]*?<\/response>/gi;
	let match: RegExpExecArray | null;
	while ((match = blockRegex.exec(normalised)) !== null) {
		const block = match[0];
		const href = /<href\b[^>]*>([\s\S]*?)<\/href>/i.exec(block)?.[1]?.trim();
		const etag = /<getetag\b[^>]*>([\s\S]*?)<\/getetag>/i.exec(block)?.[1]?.trim();
		const dataMatch = /<calendar-data\b[^>]*>([\s\S]*?)<\/calendar-data>/i.exec(block);
		const data = dataMatch ? decodeXmlText(dataMatch[1]) : undefined;
		results.push({ href, etag, data });
	}
	return results;
}

function decodeXmlText(s: string): string {
	return s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
		.replace(/&amp;/g, '&');
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Fetch a UTC-stamped calendar-query REPORT body for the date window.
 * VTIMEZONE is expanded server-side when supported; we still re-parse and
 * expand any RRULE client-side to normalise behaviour across servers.
 */
export function buildCalendarQueryBody(start: Date, end: Date): string {
	return [
		'<?xml version="1.0" encoding="utf-8" ?>',
		'<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">',
		'  <d:prop>',
		'    <d:getetag />',
		'    <c:calendar-data />',
		'  </d:prop>',
		'  <c:filter>',
		'    <c:comp-filter name="VCALENDAR">',
		'      <c:comp-filter name="VEVENT">',
		`        <c:time-range start="${formatUtcStamp(start)}" end="${formatUtcStamp(end)}" />`,
		'      </c:comp-filter>',
		'    </c:comp-filter>',
		'  </c:filter>',
		'</c:calendar-query>',
	].join('\r\n');
}

export async function calendarQuery(
	ctx: IExecuteFunctions,
	credentials: CalDavCredentials,
	start: Date,
	end: Date,
): Promise<ResourceSummary[]> {
	const url = ensureTrailingSlash(credentials.serverUrl);
	const response = await request(ctx, credentials, {
		method: 'REPORT',
		url,
		headers: {
			Depth: '1',
			'Content-Type': 'application/xml; charset=utf-8',
		},
		body: buildCalendarQueryBody(start, end),
	});

	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw new Error(
			`CalDAV REPORT failed: HTTP ${response.statusCode} ${truncate(response.body, 500)}`,
		);
	}

	const xml = isXml(response.headers['content-type']) || response.body.trim().startsWith('<')
		? response.body
		: response.body;
	const entries = extractResponses(xml);
	return entries
		.filter((e) => e.data)
		.map((e) => ({
			href: e.href ?? '',
			etag: e.etag,
			data: e.data,
		}));
}

/**
 * Free-Busy report. Some servers only accept this at the principal URL, so we
 * fall back to running a calendar-query if free-busy is rejected.
 */
export async function freeBusyQuery(
	ctx: IExecuteFunctions,
	credentials: CalDavCredentials,
	start: Date,
	end: Date,
): Promise<{ busy: Array<{ start: Date; end: Date }>; raw: string; fallback: boolean }> {
	const body = [
		'<?xml version="1.0" encoding="utf-8" ?>',
		'<c:free-busy-query xmlns:c="urn:ietf:params:xml:ns:caldav">',
		`  <c:time-range start="${formatUtcStamp(start)}" end="${formatUtcStamp(end)}" />`,
		'</c:free-busy-query>',
	].join('\r\n');

	const url = ensureTrailingSlash(credentials.serverUrl);
	const response = await request(ctx, credentials, {
		method: 'REPORT',
		url,
		headers: {
			Depth: '1',
			'Content-Type': 'application/xml; charset=utf-8',
		},
		body,
	});

	if (response.statusCode >= 200 && response.statusCode < 300 && response.body.includes('FREEBUSY')) {
		const busy: Array<{ start: Date; end: Date }> = [];
		const fbRegex = /FREEBUSY(?:;[^:]*)?:([^\r\n]+)/g;
		let m: RegExpExecArray | null;
		while ((m = fbRegex.exec(response.body)) !== null) {
			const ranges = m[1].split(',');
			for (const range of ranges) {
				const [s, e] = range.split('/');
				if (!s || !e) continue;
				try {
					busy.push({ start: parseUtcStamp(s), end: parseUtcStamp(e) });
				} catch {
					// ignore malformed ranges
				}
			}
		}
		return { busy, raw: response.body, fallback: false };
	}

	// Server-level fallback: infer busy intervals from calendar-query results.
	return { busy: [], raw: response.body, fallback: true };
}

function parseUtcStamp(value: string): Date {
	const v = value.trim();
	const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(v);
	if (!m) throw new Error(`Bad UTC stamp: ${v}`);
	return new Date(
		Date.UTC(
			Number(m[1]),
			Number(m[2]) - 1,
			Number(m[3]),
			Number(m[4]),
			Number(m[5]),
			Number(m[6]),
		),
	);
}

// -----------------------------------------------------------------------------
// PUT / DELETE / GET for a single resource
// -----------------------------------------------------------------------------

export async function putEvent(
	ctx: IExecuteFunctions,
	credentials: CalDavCredentials,
	uid: string,
	icalBody: string,
	options: { ifMatch?: string; ifNoneMatch?: string } = {},
): Promise<{ etag?: string; href: string }> {
	const safeUid = sanitizeUid(uid);
	const segment = `${encodeURIComponent(safeUid)}.ics`;
	assertSafePathSegment(segment);
	const url = joinUrl(credentials.serverUrl, segment);

	const headers: Record<string, string> = {
		'Content-Type': 'text/calendar; charset=utf-8',
	};
	if (options.ifMatch) headers['If-Match'] = options.ifMatch;
	if (options.ifNoneMatch) headers['If-None-Match'] = options.ifNoneMatch;

	const response = await request(ctx, credentials, {
		method: 'PUT',
		url,
		headers,
		body: icalBody,
	});

	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw new Error(
			`CalDAV PUT failed: HTTP ${response.statusCode} ${truncate(response.body, 500)}`,
		);
	}
	return {
		etag: response.headers.etag ?? response.headers.ETag,
		href: url,
	};
}

export async function getEvent(
	ctx: IExecuteFunctions,
	credentials: CalDavCredentials,
	uid: string,
): Promise<{ data: string; etag?: string; href: string } | null> {
	const safeUid = sanitizeUid(uid);
	const segment = `${encodeURIComponent(safeUid)}.ics`;
	assertSafePathSegment(segment);
	const url = joinUrl(credentials.serverUrl, segment);

	const response = await request(ctx, credentials, {
		method: 'GET',
		url,
		headers: { Accept: 'text/calendar' },
	});
	if (response.statusCode === 404) return null;
	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw new Error(
			`CalDAV GET failed: HTTP ${response.statusCode} ${truncate(response.body, 500)}`,
		);
	}
	return {
		data: response.body,
		etag: response.headers.etag ?? response.headers.ETag,
		href: url,
	};
}

export async function deleteEvent(
	ctx: IExecuteFunctions,
	credentials: CalDavCredentials,
	uid: string,
): Promise<{ deleted: boolean; statusCode: number }> {
	const safeUid = sanitizeUid(uid);
	const segment = `${encodeURIComponent(safeUid)}.ics`;
	assertSafePathSegment(segment);
	const url = joinUrl(credentials.serverUrl, segment);

	const response = await request(ctx, credentials, {
		method: 'DELETE',
		url,
	});
	if (response.statusCode === 404) return { deleted: false, statusCode: 404 };
	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw new Error(
			`CalDAV DELETE failed: HTTP ${response.statusCode} ${truncate(response.body, 500)}`,
		);
	}
	return { deleted: true, statusCode: response.statusCode };
}

function truncate(s: string, n: number): string {
	if (!s) return '';
	return s.length > n ? s.slice(0, n) + '…' : s;
}

// Keep escapeICalText re-exported so callers don't need to import Utils twice.
export { escapeICalText };

// IDataObject kept in the type-only import for tree-shaking users of this module.
export type { IDataObject };
