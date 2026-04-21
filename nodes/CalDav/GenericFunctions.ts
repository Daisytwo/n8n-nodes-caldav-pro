import type {
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import { XMLParser } from 'fast-xml-parser';
// ical.js is a CommonJS module; default import works under esModuleInterop.
import ICAL from 'ical.js';

export interface CalDavCalendar {
	url: string;
	displayName: string;
	color?: string;
	ctag?: string;
}

export interface CalDavEvent {
	uid: string;
	url: string;
	etag?: string;
	summary?: string;
	description?: string;
	location?: string;
	start?: string;
	end?: string;
	allDay?: boolean;
	rrule?: string;
	attendees?: string[];
	reminders?: Array<{ minutesBefore: number; action: string }>;
	raw?: string;
}

export interface EventReminder {
	minutesBefore: number;
	action?: 'DISPLAY' | 'EMAIL';
}

type RequestCtx = IExecuteFunctions | ILoadOptionsFunctions;

const xmlParser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '@_',
	removeNSPrefix: true,
	parseTagValue: false,
	trimValues: true,
	allowBooleanAttributes: true,
});

/**
 * Absolutise a possibly-relative href returned by the server (CalDAV servers
 * often return path-only hrefs like "/calendars/user/uuid/"). We resolve
 * against the credential's serverUrl origin.
 */
export function absoluteUrl(href: string, baseUrl: string): string {
	if (!href) return href;
	if (/^https?:\/\//i.test(href)) return href;
	const base = new URL(baseUrl);
	return `${base.origin}${href.startsWith('/') ? '' : '/'}${href}`;
}

/**
 * Low-level authenticated CalDAV request. Uses httpRequestWithAuthentication
 * so that the credential's authenticate() hook injects Basic auth.
 */
export async function davRequest(
	this: RequestCtx,
	method: string,
	url: string,
	body?: string,
	extraHeaders?: Record<string, string>,
): Promise<{ statusCode: number; body: string; headers: Record<string, string | string[]> }> {
	const options: IHttpRequestOptions = {
		method: method as IHttpRequestMethods,
		url,
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
			Accept: 'application/xml, text/xml, text/calendar',
			...extraHeaders,
		},
		body,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		json: false,
	};
	try {
		const response = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			'calDavApi',
			options,
		)) as { statusCode: number; body: string; headers: Record<string, string | string[]> };
		if (response.statusCode >= 400) {
			const msg = `CalDAV ${method} ${url} failed: ${response.statusCode}`;
			throw new NodeApiError(
				this.getNode(),
				{ message: msg, description: response.body } as unknown as JsonObject,
				{ httpCode: String(response.statusCode) },
			);
		}
		return response;
	} catch (error) {
		if (error instanceof NodeApiError) throw error;
		throw new NodeApiError(this.getNode(), error as JsonObject);
	}
}

/**
 * Extract href values from a WebDAV multistatus response XML. Each
 * d:response has one d:href identifying the resource it describes.
 */
function extractResponses(xml: string): any[] {
	const parsed = xmlParser.parse(xml);
	const root = parsed.multistatus ?? parsed['multistatus'];
	if (!root) return [];
	const responses = root.response;
	if (!responses) return [];
	return Array.isArray(responses) ? responses : [responses];
}

function getFirstPropstat(resp: any): any {
	const ps = resp.propstat;
	if (!ps) return null;
	const arr = Array.isArray(ps) ? ps : [ps];
	return arr.find((p) => !p.status || /200/.test(p.status)) ?? arr[0];
}

/**
 * Best-effort discovery of the user's calendar-home-set. Walks the RFC 6764
 * well-known chain, then falls back to provider-conventional paths.
 * Every step is debug-logged so misconfigurations are traceable.
 */
export async function discoverCalendarHome(
	this: RequestCtx,
	serverUrl: string,
	username: string,
): Promise<string> {
	const base = serverUrl.replace(/\/$/, '');
	const logger = (this as IExecuteFunctions).logger;

	const principalBody = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
	const homeBody = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-home-set/></d:prop>
</d:propfind>`;

	const tryPrincipal = async (url: string): Promise<string | null> => {
		try {
			const resp = await davRequest.call(this, 'PROPFIND', url, principalBody, { Depth: '0' });
			for (const r of extractResponses(resp.body)) {
				const href = getFirstPropstat(r)?.prop?.['current-user-principal']?.href;
				if (href) return absoluteUrl(href, serverUrl);
			}
		} catch (e) {
			logger?.debug(`[CalDAV] principal probe ${url} failed: ${(e as Error).message}`);
		}
		return null;
	};

	const tryHome = async (url: string): Promise<string | null> => {
		try {
			const resp = await davRequest.call(this, 'PROPFIND', url, homeBody, { Depth: '0' });
			for (const r of extractResponses(resp.body)) {
				const href = getFirstPropstat(r)?.prop?.['calendar-home-set']?.href;
				if (href) {
					const home = absoluteUrl(href, serverUrl);
					return home.endsWith('/') ? home : `${home}/`;
				}
			}
		} catch (e) {
			logger?.debug(`[CalDAV] home probe ${url} failed: ${(e as Error).message}`);
		}
		return null;
	};

	// Step 1: RFC 6764 well-known path. Note: some servers (Infomaniak) 302-redirect
	// to http:// which HTTP clients may refuse to follow — we just swallow the failure.
	logger?.debug(`[CalDAV] discover step 1: well-known/caldav`);
	let principalUrl = await tryPrincipal(`${base}/.well-known/caldav`);

	// Step 2: PROPFIND on server root — SabreDAV-based servers (Infomaniak) expose
	// current-user-principal here. This is the most portable discovery path.
	if (!principalUrl) {
		logger?.debug(`[CalDAV] discover step 2: PROPFIND ${base}/`);
		principalUrl = await tryPrincipal(`${base}/`);
	}

	// Step 3: principal -> calendar-home-set
	if (principalUrl) {
		logger?.debug(`[CalDAV] discover step 3: home-set from ${principalUrl}`);
		const home = await tryHome(principalUrl);
		if (home) {
			logger?.debug(`[CalDAV] calendar-home-set = ${home}`);
			return home;
		}
	}

	// Step 4: conventional principals path, without "/users/" segment
	const altPrincipal = `${base}/principals/${encodeURIComponent(username)}/`;
	logger?.debug(`[CalDAV] discover step 4: fallback ${altPrincipal}`);
	const altHome = await tryHome(altPrincipal);
	if (altHome) return altHome;

	// Step 5: legacy /principals/users/ (CalendarServer/DAViCal convention)
	const legacyPrincipal = `${base}/principals/users/${encodeURIComponent(username)}/`;
	logger?.debug(`[CalDAV] discover step 5: legacy ${legacyPrincipal}`);
	const legacyHome = await tryHome(legacyPrincipal);
	if (legacyHome) return legacyHome;

	// Step 6: last-resort conventional calendars path
	const fallback = `${base}/calendars/${encodeURIComponent(username)}/`;
	logger?.debug(`[CalDAV] discover step 6: last-resort ${fallback}`);
	return fallback;
}

/**
 * List all calendar collections under calendar-home-set. We filter on
 * resourcetype containing <c:calendar/> so subscribed feeds or principals
 * don't leak into the dropdown.
 */
export async function discoverCalendars(
	this: RequestCtx,
	serverUrl: string,
	username: string,
): Promise<CalDavCalendar[]> {
	const home = await discoverCalendarHome.call(this, serverUrl, username);
	const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <cs:getctag/>
    <ic:calendar-color/>
  </d:prop>
</d:propfind>`;
	const resp = await davRequest.call(this, 'PROPFIND', home, body, { Depth: '1' });
	const responses = extractResponses(resp.body);
	const calendars: CalDavCalendar[] = [];
	for (const r of responses) {
		const href = r.href;
		if (!href) continue;
		const ps = getFirstPropstat(r);
		const prop = ps?.prop;
		const rt = prop?.resourcetype;
		if (!rt || rt.calendar === undefined) continue;
		const display = prop?.displayname;
		const displayName =
			typeof display === 'string' ? display : (display?.['#text'] ?? href);
		calendars.push({
			url: absoluteUrl(href, serverUrl),
			displayName: String(displayName).trim() || href,
			color: prop?.['calendar-color'],
			ctag: prop?.['getctag'],
		});
	}
	return calendars;
}

/* ─────────────── iCalendar build/parse helpers ─────────────── */

export interface BuildEventInput {
	uid: string;
	summary: string;
	start: string;
	end: string;
	description?: string;
	location?: string;
	allDay?: boolean;
	timezone?: string;
	rrule?: string;
	attendees?: Array<{ email: string; name?: string }>;
	reminders?: EventReminder[];
}

function isoToICalDate(iso: string, allDay: boolean, tz?: string): { value: string; params?: Record<string, string> } {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) {
		throw new Error(`Invalid ISO 8601 date: ${iso}`);
	}
	if (allDay) {
		const y = d.getUTCFullYear();
		const m = String(d.getUTCMonth() + 1).padStart(2, '0');
		const day = String(d.getUTCDate()).padStart(2, '0');
		return { value: `${y}${m}${day}`, params: { VALUE: 'DATE' } };
	}
	if (tz) {
		// Floating local time with TZID. Format YYYYMMDDTHHMMSS.
		const pad = (n: number) => String(n).padStart(2, '0');
		const value =
			`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T` +
			`${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
		return { value, params: { TZID: tz } };
	}
	// UTC (Z suffix)
	const utc =
		`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}T` +
		`${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}Z`;
	return { value: utc };
}

/**
 * Build a minimal RFC 5545 VCALENDAR/VEVENT. Done by string assembly rather
 * than ICAL.Component because the latter pulls in a large object graph for
 * a task this small.
 */
export function buildICalEvent(input: BuildEventInput): string {
	const esc = (s: string) =>
		s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
	const now = new Date();
	const dtstamp =
		`${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}T` +
		`${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}${String(now.getUTCSeconds()).padStart(2, '0')}Z`;

	const start = isoToICalDate(input.start, !!input.allDay, input.timezone);
	const end = isoToICalDate(input.end, !!input.allDay, input.timezone);

	const lines: string[] = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//Daisytwo//n8n-nodes-caldav-pro//EN',
		'CALSCALE:GREGORIAN',
		'BEGIN:VEVENT',
		`UID:${input.uid}`,
		`DTSTAMP:${dtstamp}`,
		formatLine('DTSTART', start),
		formatLine('DTEND', end),
		`SUMMARY:${esc(input.summary)}`,
	];
	if (input.description) lines.push(`DESCRIPTION:${esc(input.description)}`);
	if (input.location) lines.push(`LOCATION:${esc(input.location)}`);
	if (input.rrule) lines.push(`RRULE:${input.rrule.replace(/^RRULE:/i, '')}`);
	if (input.attendees?.length) {
		for (const a of input.attendees) {
			const cn = a.name ? `;CN=${esc(a.name)}` : '';
			lines.push(`ATTENDEE${cn};RSVP=TRUE:mailto:${a.email}`);
		}
	}
	if (input.reminders?.length) {
		for (const r of input.reminders) {
			const action = (r.action ?? 'DISPLAY').toUpperCase();
			const mins = Math.max(0, Math.floor(r.minutesBefore));
			lines.push('BEGIN:VALARM');
			lines.push(`ACTION:${action}`);
			lines.push(`TRIGGER:-PT${mins}M`);
			lines.push(`DESCRIPTION:${esc(input.summary)}`);
			lines.push('END:VALARM');
		}
	}
	lines.push('END:VEVENT', 'END:VCALENDAR');
	return lines.join('\r\n') + '\r\n';
}

function formatLine(prop: string, v: { value: string; params?: Record<string, string> }): string {
	if (!v.params) return `${prop}:${v.value}`;
	const params = Object.entries(v.params)
		.map(([k, val]) => `;${k}=${val}`)
		.join('');
	return `${prop}${params}:${v.value}`;
}

/**
 * Parse a raw iCalendar VCALENDAR into a normalised event. Uses ical.js for
 * robust handling of folded lines, TZID, and RRULE.
 */
export function parseICalEvent(raw: string, url: string, etag?: string): CalDavEvent | null {
	try {
		const jcal = ICAL.parse(raw);
		const comp = new ICAL.Component(jcal);
		const vevent = comp.getFirstSubcomponent('vevent');
		if (!vevent) return null;
		const event = new ICAL.Event(vevent);
		const attendees = vevent
			.getAllProperties('attendee')
			.map((p: any) => {
				const val = p.getFirstValue();
				return typeof val === 'string' ? val.replace(/^mailto:/i, '') : '';
			})
			.filter(Boolean);
		const rruleProp = vevent.getFirstProperty('rrule');
		const reminders: Array<{ minutesBefore: number; action: string }> = [];
		for (const valarm of vevent.getAllSubcomponents('valarm')) {
			const action = (valarm.getFirstPropertyValue('action') as string | null) ?? 'DISPLAY';
			const trigger = valarm.getFirstProperty('trigger');
			if (!trigger) continue;
			const tv = trigger.getFirstValue();
			// ICAL.Duration: negative durations are "before start". Convert to minutes.
			let minutes = 0;
			if (tv && typeof tv === 'object' && 'toSeconds' in tv) {
				const seconds = (tv as any).toSeconds();
				minutes = Math.round(Math.abs(seconds) / 60);
			} else if (typeof tv === 'string') {
				const match = /([-+]?)P?T?(\d+)([HMD])/i.exec(tv);
				if (match) {
					const n = parseInt(match[2], 10);
					minutes = match[3].toUpperCase() === 'H' ? n * 60 : match[3].toUpperCase() === 'D' ? n * 1440 : n;
				}
			}
			reminders.push({ minutesBefore: minutes, action: String(action) });
		}
		return {
			uid: event.uid,
			url,
			etag,
			summary: event.summary ?? undefined,
			description: event.description ?? undefined,
			location: event.location ?? undefined,
			start: event.startDate?.toString(),
			end: event.endDate?.toString(),
			allDay: event.startDate?.isDate ?? false,
			rrule: rruleProp ? rruleProp.getFirstValue()?.toString() : undefined,
			attendees,
			reminders: reminders.length ? reminders : undefined,
			raw,
		};
	} catch {
		return null;
	}
}

/**
 * Build the REPORT request body for a calendar-query with an optional time-range.
 * timeMin/timeMax are ISO 8601 strings; converted to iCal UTC format YYYYMMDDTHHMMSSZ.
 */
export function buildTimeRangeReport(timeMin: string, timeMax: string): string {
	const toIcal = (iso: string) => {
		const d = new Date(iso);
		return (
			`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}T` +
			`${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}Z`
		);
	};
	return `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${toIcal(timeMin)}" end="${toIcal(timeMax)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

/**
 * Parse a multistatus REPORT response into CalDavEvent records.
 */
export function parseCalendarQueryResponse(
	xml: string,
	calendarUrl: string,
	serverUrl: string,
): CalDavEvent[] {
	const responses = extractResponses(xml);
	const events: CalDavEvent[] = [];
	for (const r of responses) {
		const href = r.href;
		if (!href) continue;
		const ps = getFirstPropstat(r);
		const prop = ps?.prop;
		if (!prop) continue;
		const calData = prop['calendar-data'];
		const raw = typeof calData === 'string' ? calData : calData?.['#text'];
		if (!raw) continue;
		const etag = (prop.getetag ?? '').toString().replace(/"/g, '');
		const url = absoluteUrl(href, serverUrl || calendarUrl);
		const parsed = parseICalEvent(raw, url, etag || undefined);
		if (parsed) events.push(parsed);
	}
	return events;
}
