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
	/**
	 * True when the server reports no write privilege for this account —
	 * typically a calendar shared with you, or a subscribed feed such as a
	 * holiday calendar. Undefined when the server does not report privileges
	 * at all, which must not be read as "read-only".
	 */
	readOnly?: boolean;
}

export interface CalDavEvent {
	uid: string;
	url: string;
	etag?: string;
	summary?: string;
	description?: string;
	location?: string;
	/** All-day events: "YYYY-MM-DD". Timed events: an ISO 8601 UTC instant. */
	start?: string;
	end?: string;
	/**
	 * The same moment as the event's own wall clock, with its offset attached
	 * ("2026-07-28T21:00:00+02:00"). Read this to display a time; read `start`
	 * to sort or compute with one.
	 */
	startLocal?: string;
	endLocal?: string;
	allDay?: boolean;
	/** The TZID the event is stored under, when it has one. */
	timezone?: string;
	rrule?: string;
	/**
	 * Set on a single occurrence of a recurring series, identifying which slot
	 * it is. All occurrences of a series share one UID and one URL.
	 */
	recurrenceId?: string;
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
 * Resolve the credential's "Default Calendar" hint into a concrete URL.
 * The hint can be a full URL, a UUID fragment, or a display-name substring
 * (case-insensitive). Throws if the hint is empty, unmatched, or ambiguous.
 */
export async function resolveDefaultCalendar(
	this: RequestCtx,
	serverUrl: string,
	username: string,
): Promise<string> {
	const creds = (await this.getCredentials('calDavApi')) as { defaultCalendar?: string };
	const hint = (creds.defaultCalendar ?? '').trim();
	if (!hint) {
		throw new Error(
			'No default calendar configured. Open the CalDAV credential and set "Default Calendar", or pick a specific calendar in the node.',
		);
	}
	if (/^https?:\/\//i.test(hint)) {
		return hint.endsWith('/') ? hint : `${hint}/`;
	}
	const calendars = await discoverCalendars.call(this, serverUrl, username);
	const lower = hint.toLowerCase();
	const matches = calendars.filter(
		(c) => c.url.toLowerCase().includes(lower) || c.displayName.toLowerCase().includes(lower),
	);
	if (matches.length === 0) {
		throw new Error(
			`Default Calendar hint "${hint}" did not match any calendar. Available: ${calendars.map((c) => c.displayName).join(', ')}`,
		);
	}
	if (matches.length > 1) {
		throw new Error(
			`Default Calendar hint "${hint}" matched ${matches.length} calendars (${matches.map((c) => c.displayName).join(', ')}). Make the hint more specific (e.g. paste the UUID fragment).`,
		);
	}
	const url = matches[0].url;
	return url.endsWith('/') ? url : `${url}/`;
}

/**
 * Lower-case substring search across summary, description, and location.
 * Used for client-side text filtering in the Search operation since CalDAV
 * `text-match` only filters on a single property at a time.
 */
export function eventMatchesText(ev: CalDavEvent, query: string): boolean {
	if (!query) return true;
	const q = query.toLowerCase();
	const haystack = [ev.summary, ev.description, ev.location, ev.uid]
		.filter(Boolean)
		.map((s) => String(s).toLowerCase())
		.join('  ');
	return haystack.includes(q);
}

/**
 * Parse a user-supplied comma-separated list of patterns into matchers.
 * Each entry can be:
 *   - a literal substring (case-insensitive `includes`) — easy mode, e.g.
 *     "190b2e38" matches any URL containing that UUID fragment, "Privat"
 *     matches any name containing "privat".
 *   - a regex wrapped in slashes, e.g. "/^Team /" or "/holiday/i" — for
 *     anchored or flag-controlled matches.
 */
function parsePatterns(input: string | undefined): Array<(value: string) => boolean> {
	if (!input || !input.trim()) return [];
	return input
		.split(',')
		.map((p) => p.trim())
		.filter(Boolean)
		.map((pattern) => {
			const re = /^\/(.+)\/([gimsuy]*)$/.exec(pattern);
			if (re) {
				try {
					const r = new RegExp(re[1], re[2]);
					return (value: string) => r.test(value);
				} catch {
					// Fall through to literal match if regex is invalid.
				}
			}
			const lower = pattern.toLowerCase();
			return (value: string) => value.toLowerCase().includes(lower);
		});
}

/**
 * List all calendar collections under calendar-home-set. We filter on
 * resourcetype containing <c:calendar/> so subscribed feeds or principals
 * don't leak into the dropdown. Then apply the user's allow/block lists
 * from the credential (allow-list first, block-list always wins).
 */
/**
 * Whether the account lacks write access to a collection, from the DAV
 * current-user-privilege-set the listing asked for.
 *
 * Returns undefined when the server reports no privileges at all — that means
 * "unknown", not "read-only", and must not be used to block writes.
 */
function readOnlyFromPrivileges(prop: any): boolean | undefined {
	const entries = prop?.['current-user-privilege-set']?.privilege;
	if (!entries) return undefined;
	const names: string[] = [];
	for (const entry of Array.isArray(entries) ? entries : [entries]) {
		if (entry && typeof entry === 'object') names.push(...Object.keys(entry));
		else if (typeof entry === 'string') names.push(entry);
	}
	if (!names.length) return undefined;
	return !names.some((n) => n === 'write' || n === 'write-content' || n === 'all');
}

/**
 * Per-execution memo for the calendar list.
 *
 * n8n hands `execute` one context object for the whole node run, so keying on
 * it gives exactly "once per execution" and lets the entry be collected when
 * the run ends. Without this, discovery — a chain of up to six PROPFINDs —
 * repeated for every input item, and again inside resolveDefaultCalendar.
 */
const calendarListCache = new WeakMap<object, Map<string, Promise<CalDavCalendar[]>>>();

export async function discoverCalendars(
	this: RequestCtx,
	serverUrl: string,
	username: string,
): Promise<CalDavCalendar[]> {
	let perContext = calendarListCache.get(this);
	if (!perContext) {
		perContext = new Map();
		calendarListCache.set(this, perContext);
	}
	const key = `${serverUrl}\n${username}`;
	const cached = perContext.get(key);
	if (cached) return cached;

	const pending = discoverCalendarsUncached.call(this, serverUrl, username);
	perContext.set(key, pending);
	// A transient failure must not poison the rest of the run.
	pending.catch(() => perContext.delete(key));
	return pending;
}

async function discoverCalendarsUncached(
	this: RequestCtx,
	serverUrl: string,
	username: string,
): Promise<CalDavCalendar[]> {
	const home = await discoverCalendarHome.call(this, serverUrl, username);
	// current-user-privilege-set rides along on the listing we already make, so
	// knowing which calendars are writable costs no extra request.
	const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <d:current-user-privilege-set/>
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
			readOnly: readOnlyFromPrivileges(prop),
		});
	}

	// Apply allow/block filters from the credential.
	let creds: { calendarAllowList?: string; calendarBlockList?: string } = {};
	try {
		creds = (await this.getCredentials('calDavApi')) as typeof creds;
	} catch {
		// In rare contexts (tests) credentials may be unavailable; skip filtering.
	}
	const allow = parsePatterns(creds.calendarAllowList);
	const block = parsePatterns(creds.calendarBlockList);
	const logger = (this as IExecuteFunctions).logger;
	// Patterns are tested against BOTH displayName and URL, so the user
	// can target a specific calendar by UUID when names collide.
	const matchesAny = (matchers: Array<(name: string) => boolean>, c: CalDavCalendar) =>
		matchers.some((m) => m(c.displayName) || m(c.url));
	const filtered = calendars.filter((c) => {
		if (allow.length && !matchesAny(allow, c)) {
			logger?.debug(`[CalDAV] filter: "${c.displayName}" hidden by allow-list`);
			return false;
		}
		if (block.length && matchesAny(block, c)) {
			logger?.debug(`[CalDAV] filter: "${c.displayName}" (${c.url}) hidden by block-list`);
			return false;
		}
		return true;
	});
	return filtered;
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

const PRODID = '-//Daisytwo//n8n-nodes-caldav-pro//EN';

/**
 * Cached Intl formatters — constructing one per call is measurably expensive
 * and we hit this once per DTSTART/DTEND on every event we write.
 */
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(tz: string): Intl.DateTimeFormat {
	let f = zoneFormatters.get(tz);
	if (!f) {
		try {
			f = new Intl.DateTimeFormat('en-US', {
				timeZone: tz,
				hourCycle: 'h23',
				year: 'numeric',
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
				second: '2-digit',
			});
		} catch {
			throw new Error(
				`Unknown timezone "${tz}". Use an IANA identifier such as "Europe/Berlin" or "America/New_York".`,
			);
		}
		zoneFormatters.set(tz, f);
	}
	return f;
}

interface WallClock {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

/**
 * The wall-clock reading an observer in `tz` would see at instant `d`.
 *
 * This must never use Date's local getters (getHours() etc.): those report the
 * n8n *host's* timezone, which in Docker is almost always UTC. Emitting those
 * components under a TZID parameter shifts every event by the host's offset.
 */
function wallClockInZone(d: Date, tz: string): WallClock {
	const parts = zoneFormatter(tz).formatToParts(d);
	const get = (type: string) => {
		const p = parts.find((x) => x.type === type);
		return p ? parseInt(p.value, 10) : 0;
	};
	// h23 should never yield 24, but ICU versions have historically disagreed.
	const hour = get('hour');
	return {
		year: get('year'),
		month: get('month'),
		day: get('day'),
		hour: hour === 24 ? 0 : hour,
		minute: get('minute'),
		second: get('second'),
	};
}

function isKnownZone(tz: string): boolean {
	try {
		zoneFormatter(tz);
		return true;
	} catch {
		return false;
	}
}

/**
 * Inverse of wallClockInZone: the instant at which observers in `tz` read the
 * given wall clock.
 *
 * Needed because ical.js can only resolve a TZID parameter when the calendar
 * object also carries a matching VTIMEZONE. Real clients ship one; events this
 * node writes do not, so their times come back "floating" and would otherwise
 * be interpreted in the n8n host's zone.
 *
 * Two correction passes: the first lands within an hour or so of the target,
 * the second settles DST boundaries where the offset differs between the guess
 * and the real instant.
 */
function wallClockToInstant(w: WallClock, tz: string): Date {
	const target = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
	let guess = target;
	for (let pass = 0; pass < 2; pass++) {
		const shown = wallClockInZone(new Date(guess), tz);
		const shownAsUtc = Date.UTC(
			shown.year,
			shown.month - 1,
			shown.day,
			shown.hour,
			shown.minute,
			shown.second,
		);
		const drift = target - shownAsUtc;
		if (drift === 0) break;
		guess += drift;
	}
	return new Date(guess);
}

/**
 * The absolute instant an ICAL.Time refers to.
 *
 * When the TZID names an IANA zone, that definition wins over any VTIMEZONE
 * the object carries. VTIMEZONE components are written by whichever tool
 * produced the event and are wrong often enough to matter: Infomaniak's own
 * importer emits `TZID:Europe/Berlin` with US transition rules whose RRULEs
 * contradict their own DTSTARTs, so no observance matches and ical.js falls
 * back to a zero offset — putting every summer event two hours late. The
 * platform's tz database has no such problem, and also carries correct
 * historical rules that embedded definitions usually omit.
 *
 * The VTIMEZONE is still the best source for a TZID we cannot map, such as an
 * Outlook-style "W. Europe Standard Time".
 */
function instantOf(time: any, tzid?: string): Date {
	if (time.isDate) {
		return new Date(Date.UTC(time.year, time.month - 1, time.day));
	}
	if (tzid && isKnownZone(tzid)) {
		return wallClockToInstant(
			{
				year: time.year,
				month: time.month,
				day: time.day,
				hour: time.hour,
				minute: time.minute,
				second: time.second,
			},
			tzid,
		);
	}
	// A non-IANA TZID with a VTIMEZONE ical.js could resolve, or a plain UTC
	// value. Failing both, the time is genuinely floating and host-local is the
	// only reading left.
	return time.toJSDate();
}

/** The zone's offset from UTC at a given instant, in minutes. */
function zoneOffsetMinutes(instant: Date, tz: string): number {
	const shown = wallClockInZone(instant, tz);
	const asUtc = Date.UTC(
		shown.year,
		shown.month - 1,
		shown.day,
		shown.hour,
		shown.minute,
		shown.second,
	);
	return Math.round((asUtc - instant.getTime()) / 60000);
}

/**
 * The event's own wall clock with its offset attached, e.g.
 * "2026-07-28T21:00:00+02:00".
 *
 * `start` is a UTC instant because that is what sorts and computes correctly,
 * but reading a local time off it requires knowing the offset in force on that
 * date. Language models get that wrong: asked to show a 19:00Z summer event in
 * Berlin, one reported 23:00 and, on a later run, 20:00 — applying no offset
 * and then the winter offset. Handing them the arithmetic already done removes
 * the guesswork.
 *
 * `fallbackZone` covers events stored in plain UTC, which carry no zone of
 * their own; the workflow's timezone is the closest thing to the reader's.
 */
function formatLocalTime(time: any, tzid?: string, fallbackZone?: string): string {
	if (time.isDate) return formatEventTime(time, tzid);
	const zone =
		tzid && isKnownZone(tzid)
			? tzid
			: fallbackZone && isKnownZone(fallbackZone)
				? fallbackZone
				: 'UTC';
	const instant = instantOf(time, tzid);
	const w = wallClockInZone(instant, zone);
	const offset = zoneOffsetMinutes(instant, zone);
	const sign = offset < 0 ? '-' : '+';
	const abs = Math.abs(offset);
	const pad = (n: number) => String(n).padStart(2, '0');
	return (
		`${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}` +
		`${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
	);
}

/**
 * Render a time for output: a bare calendar date for all-day events, and an
 * unambiguous UTC instant otherwise.
 *
 * Previously this emitted ICAL.Time.toString(), which for a TZID event yields
 * "2026-04-20T14:00:00" with no offset — re-parsing that downstream applied the
 * host's zone and silently moved the event.
 */
function formatEventTime(time: any, tzid?: string): string {
	if (time.isDate) {
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${time.year}-${pad(time.month)}-${pad(time.day)}`;
	}
	return instantOf(time, tzid).toISOString();
}

function parseInstant(iso: string, field: string): Date {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) {
		throw new Error(
			`Invalid ISO 8601 date in "${field}": ${iso}. Expected something like "2026-04-20T14:00:00+02:00".`,
		);
	}
	return d;
}

/**
 * The calendar date literally written in an ISO string, ignoring any offset.
 *
 * For all-day events this is what the user means: "2026-04-20T00:00:00+02:00"
 * with All Day ticked is the 20th, even though that instant is the 19th in UTC.
 * Returns null for inputs that aren't shaped like a date (epoch millis, etc.),
 * so callers can fall back to a zone-based reading.
 */
function literalDate(iso: string): { year: number; month: number; day: number } | null {
	const m = /^\s*(\d{4})-(\d{2})-(\d{2})/.exec(iso);
	if (!m) return null;
	return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function allDayTime(iso: string, field: string, tz?: string): any {
	const literal = literalDate(iso);
	const parts = literal ?? wallClockInZone(parseInstant(iso, field), tz ?? 'UTC');
	return ICAL.Time.fromData({
		year: parts.year,
		month: parts.month,
		day: parts.day,
		isDate: true,
	});
}

function timedTime(iso: string, field: string, tz?: string): any {
	const d = parseInstant(iso, field);
	if (tz) {
		const w = wallClockInZone(d, tz);
		return ICAL.Time.fromData({ ...w, isDate: false });
	}
	return ICAL.Time.fromData(
		{
			year: d.getUTCFullYear(),
			month: d.getUTCMonth() + 1,
			day: d.getUTCDate(),
			hour: d.getUTCHours(),
			minute: d.getUTCMinutes(),
			second: d.getUTCSeconds(),
			isDate: false,
		},
		ICAL.Timezone.utcTimezone,
	);
}

function setDateProperty(vevent: any, name: string, value: any, tz?: string, allDay?: boolean) {
	vevent.removeAllProperties(name);
	const prop = new ICAL.Property(name, vevent);
	if (allDay) prop.resetType('date');
	prop.setValue(value);
	if (!allDay && tz) prop.setParameter('tzid', tz);
	vevent.addProperty(prop);
}

/**
 * Write DTSTART/DTEND as a consistent pair.
 *
 * All-day events use VALUE=DATE, where RFC 5545 defines DTEND as *exclusive*.
 * Users (and LLMs) overwhelmingly supply an inclusive end — "20th to the 20th"
 * for a one-day event, or an end of 23:59 on the same day — which would encode
 * a zero-length event. We bump any end that lands on or before the start by one
 * day so the common case means what it looks like; genuinely multi-day ranges
 * already written exclusively are left alone.
 */
function applyDateRange(vevent: any, start: string, end: string, allDay: boolean, tz?: string) {
	if (allDay) {
		const s = allDayTime(start, 'Start', tz);
		const e = allDayTime(end, 'End', tz);
		if (e.compare(s) <= 0) {
			e.adjust(1, 0, 0, 0);
		}
		setDateProperty(vevent, 'dtstart', s, undefined, true);
		setDateProperty(vevent, 'dtend', e, undefined, true);
		return;
	}
	setDateProperty(vevent, 'dtstart', timedTime(start, 'Start', tz), tz, false);
	setDateProperty(vevent, 'dtend', timedTime(end, 'End', tz), tz, false);
}

function utcNow(): any {
	const d = new Date();
	return ICAL.Time.fromData(
		{
			year: d.getUTCFullYear(),
			month: d.getUTCMonth() + 1,
			day: d.getUTCDate(),
			hour: d.getUTCHours(),
			minute: d.getUTCMinutes(),
			second: d.getUTCSeconds(),
			isDate: false,
		},
		ICAL.Timezone.utcTimezone,
	);
}

function setAttendees(vevent: any, attendees: Array<{ email: string; name?: string }>) {
	vevent.removeAllProperties('attendee');
	for (const a of attendees) {
		if (!a?.email) continue;
		const prop = new ICAL.Property('attendee', vevent);
		prop.setValue(`mailto:${a.email}`);
		if (a.name) prop.setParameter('cn', a.name);
		prop.setParameter('rsvp', 'TRUE');
		vevent.addProperty(prop);
	}
}

function setReminders(vevent: any, reminders: EventReminder[], description: string) {
	for (const existing of vevent.getAllSubcomponents('valarm')) {
		vevent.removeSubcomponent(existing);
	}
	for (const r of reminders) {
		const alarm = new ICAL.Component('valarm');
		alarm.addPropertyWithValue('action', (r.action ?? 'DISPLAY').toUpperCase());
		const mins = Math.max(0, Math.floor(r.minutesBefore));
		alarm.addPropertyWithValue('trigger', ICAL.Duration.fromSeconds(-mins * 60));
		alarm.addPropertyWithValue('description', description || 'Reminder');
		vevent.addSubcomponent(alarm);
	}
}

/**
 * Set a text property, or remove it when the caller passes an empty string.
 * That gives Update an explicit way to clear a field, distinct from "leave
 * untouched" (which is signalled by passing undefined and never reaching here).
 */
function setOrClear(vevent: any, name: string, value: string) {
	if (value === '') {
		vevent.removeAllProperties(name);
		return;
	}
	vevent.updatePropertyWithValue(name, value);
}

/**
 * Build a complete RFC 5545 VCALENDAR/VEVENT.
 *
 * Serialisation goes through ical.js rather than string concatenation so that
 * line folding, text escaping, and parameter quoting follow the spec instead of
 * a hand-rolled approximation.
 */
export function buildICalEvent(input: BuildEventInput): string {
	const vcal = new ICAL.Component('vcalendar');
	vcal.addPropertyWithValue('version', '2.0');
	vcal.addPropertyWithValue('prodid', PRODID);
	vcal.addPropertyWithValue('calscale', 'GREGORIAN');

	const vevent = new ICAL.Component('vevent');
	vcal.addSubcomponent(vevent);

	vevent.addPropertyWithValue('uid', input.uid);
	const stamp = new ICAL.Property('dtstamp', vevent);
	stamp.setValue(utcNow());
	vevent.addProperty(stamp);

	applyDateRange(vevent, input.start, input.end, !!input.allDay, input.timezone);
	vevent.addPropertyWithValue('summary', input.summary);

	if (input.description) vevent.addPropertyWithValue('description', input.description);
	if (input.location) vevent.addPropertyWithValue('location', input.location);
	if (input.rrule) {
		vevent.addPropertyWithValue('rrule', ICAL.Recur.fromString(input.rrule.replace(/^RRULE:/i, '')));
	}
	if (input.attendees?.length) setAttendees(vevent, input.attendees);
	if (input.reminders?.length) setReminders(vevent, input.reminders, input.summary);

	return `${vcal.toString()}\r\n`;
}

/**
 * Fields an Update may change. Every key is optional and carries three states:
 *   - absent (undefined) → leave whatever the server already has
 *   - empty string / empty array → clear the property
 *   - a value → overwrite
 * That distinction is what keeps Update from silently wiping fields the caller
 * simply didn't mention.
 */
export interface PatchEventInput {
	summary?: string;
	start?: string;
	end?: string;
	description?: string;
	location?: string;
	allDay?: boolean;
	timezone?: string;
	rrule?: string;
	attendees?: Array<{ email: string; name?: string }>;
	reminders?: EventReminder[];
}

/**
 * Apply a partial update to an existing VEVENT, preserving everything the
 * patch doesn't mention — including properties this node doesn't model at all
 * (CATEGORIES, ORGANIZER, ATTACH, STATUS, custom X- properties).
 *
 * Rebuilding the event from scratch, as an earlier version did, dropped all of
 * those plus any field the caller left blank.
 */
/** Apply the patch's fields to one VEVENT, leaving anything it omits alone. */
function applyPatchFields(vevent: any, patch: PatchEventInput) {
	if (patch.start !== undefined || patch.end !== undefined) {
		if (patch.start === undefined || patch.end === undefined) {
			throw new Error('Start and End must be updated together.');
		}
		const dtstart = vevent.getFirstProperty('dtstart');
		// Fall back to how the event is currently stored, so updating only the
		// time of an all-day event doesn't silently convert it to a timed one,
		// and an event's existing TZID survives an update that omits Timezone.
		const existingAllDay = dtstart?.type === 'date';
		const existingTz = dtstart?.getParameter('tzid') as string | undefined;
		const allDay = patch.allDay ?? existingAllDay;
		const tz = patch.timezone ?? existingTz;
		applyDateRange(vevent, patch.start, patch.end, allDay, tz);
	}

	if (patch.summary !== undefined) setOrClear(vevent, 'summary', patch.summary);
	if (patch.description !== undefined) setOrClear(vevent, 'description', patch.description);
	if (patch.location !== undefined) setOrClear(vevent, 'location', patch.location);
	if (patch.rrule !== undefined) {
		const value = patch.rrule.replace(/^RRULE:/i, '');
		if (value === '') {
			vevent.removeAllProperties('rrule');
		} else {
			vevent.updatePropertyWithValue('rrule', ICAL.Recur.fromString(value));
		}
	}
	if (patch.attendees !== undefined) setAttendees(vevent, patch.attendees);
	if (patch.reminders !== undefined) {
		const label =
			patch.summary ?? (vevent.getFirstPropertyValue('summary') as string | null) ?? 'Reminder';
		setReminders(vevent, patch.reminders, String(label));
	}
}

/**
 * Mark a component as changed. RFC 5545: SEQUENCE must increase on every change
 * attendees should see, or clients may treat the update as a stale duplicate.
 */
function bumpRevision(vevent: any) {
	const seq = Number(vevent.getFirstPropertyValue('sequence') ?? 0);
	vevent.updatePropertyWithValue('sequence', (Number.isFinite(seq) ? seq : 0) + 1);
	for (const name of ['dtstamp', 'last-modified']) {
		vevent.removeAllProperties(name);
		const prop = new ICAL.Property(name, vevent);
		prop.setValue(utcNow());
		vevent.addProperty(prop);
	}
}

/** The series master: the VEVENT that carries no RECURRENCE-ID. */
function masterOf(comp: any): any {
	const vevents = comp.getAllSubcomponents('vevent');
	return vevents.find((v: any) => !v.hasProperty('recurrence-id')) ?? vevents[0];
}

export function patchICalEvent(raw: string, patch: PatchEventInput): string {
	const comp = new ICAL.Component(ICAL.parse(raw));
	const vevent = comp.getFirstSubcomponent('vevent');
	if (!vevent) {
		throw new Error('The stored calendar resource contains no VEVENT — refusing to overwrite it.');
	}
	applyPatchFields(vevent, patch);
	bumpRevision(vevent);
	return `${comp.toString()}\r\n`;
}

function readAttendees(vevent: any): string[] {
	return vevent
		.getAllProperties('attendee')
		.map((p: any) => {
			const val = p.getFirstValue();
			return typeof val === 'string' ? val.replace(/^mailto:/i, '') : '';
		})
		.filter(Boolean);
}

function readReminders(vevent: any): Array<{ minutesBefore: number; action: string }> {
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
				minutes =
					match[3].toUpperCase() === 'H' ? n * 60 : match[3].toUpperCase() === 'D' ? n * 1440 : n;
			}
		}
		reminders.push({ minutesBefore: minutes, action: String(action) });
	}
	return reminders;
}

/** The TZID written on a component's DTSTART, if any. */
function startTzid(vevent: any): string | undefined {
	return vevent.getFirstProperty('dtstart')?.getParameter('tzid') as string | undefined;
}

/**
 * Assemble one output record. `times` overrides the component's own DTSTART /
 * DTEND, which is how a single occurrence of a series reports its own slot
 * while still carrying the series' details.
 */
function toCalDavEvent(
	vevent: any,
	url: string,
	etag: string | undefined,
	raw: string,
	times?: { start: any; end: any; recurrenceId?: any; tzid?: string },
	localZone?: string,
): CalDavEvent {
	const event = new ICAL.Event(vevent);
	const tzid = times?.tzid ?? startTzid(vevent);
	const start = times?.start ?? event.startDate;
	const end = times?.end ?? event.endDate;
	const rruleProp = vevent.getFirstProperty('rrule');
	const reminders = readReminders(vevent);
	return {
		uid: event.uid,
		url,
		etag,
		summary: event.summary ?? undefined,
		description: event.description ?? undefined,
		location: event.location ?? undefined,
		start: start ? formatEventTime(start, tzid) : undefined,
		end: end ? formatEventTime(end, tzid) : undefined,
		startLocal: start ? formatLocalTime(start, tzid, localZone) : undefined,
		endLocal: end ? formatLocalTime(end, tzid, localZone) : undefined,
		allDay: start?.isDate ?? false,
		timezone: tzid,
		rrule: rruleProp ? rruleProp.getFirstValue()?.toString() : undefined,
		recurrenceId: times?.recurrenceId ? formatEventTime(times.recurrenceId, tzid) : undefined,
		attendees: readAttendees(vevent),
		reminders: reminders.length ? reminders : undefined,
		raw,
	};
}

/**
 * Parse a raw iCalendar VCALENDAR into a normalised event. Uses ical.js for
 * robust handling of folded lines, TZID, and RRULE.
 *
 * Returns the series master for a recurring event; use expandCalendarObject
 * when you want the individual occurrences.
 */
export function parseICalEvent(
	raw: string,
	url: string,
	etag?: string,
	localZone?: string,
): CalDavEvent | null {
	try {
		const comp = new ICAL.Component(ICAL.parse(raw));
		const vevents = comp.getAllSubcomponents('vevent');
		if (!vevents.length) return null;
		// Prefer the master. Taking the first component blindly would return an
		// overridden instance when the server happens to serialise it first.
		const master = vevents.find((v: any) => !v.hasProperty('recurrence-id')) ?? vevents[0];
		return toCalDavEvent(master, url, etag, raw, undefined, localZone);
	} catch {
		return null;
	}
}

/**
 * Find the slot a `recurrenceId` names, as the series itself generates it.
 *
 * The value has to come from the rule rather than from the caller's string:
 * an overridden instance may have been moved, and EXDATE and RECURRENCE-ID
 * must both carry the *original* slot, not where the event ended up.
 */
function findOccurrence(master: any, tzid: string | undefined, recurrenceId: string): any | null {
	const event = new ICAL.Event(master);
	if (!event.isRecurring()) return null;
	const target = new Date(recurrenceId).getTime();
	const iterator = event.iterator();
	let next: any;
	let iterations = 0;
	while ((next = iterator.next())) {
		if (++iterations > MAX_ITERATIONS_PER_OBJECT) break;
		if (formatEventTime(next, tzid) === recurrenceId) return next;
		// The iterator is ordered, so once we are past the target it is not here.
		if (!Number.isNaN(target) && instantOf(next, tzid).getTime() > target) break;
	}
	return null;
}

/** Copy DTSTART's storage form onto another date property. */
function dateLike(name: string, source: any, value: any, owner: any): any {
	const prop = new ICAL.Property(name, owner);
	const isDate = source?.type === 'date';
	if (isDate) prop.resetType('date');
	prop.setValue(value);
	const tzid = source?.getParameter('tzid');
	if (!isDate && tzid) prop.setParameter('tzid', tzid);
	return prop;
}

/**
 * Remove a single occurrence from a series by excluding its slot.
 *
 * The whole series lives in one resource under one UID, so a single occurrence
 * cannot be deleted on its own — it is cancelled by adding its slot to EXDATE.
 * Any override previously written for that slot goes too, or it would linger as
 * an orphan the server still returns.
 */
export function removeOccurrence(raw: string, recurrenceId: string): string {
	const comp = new ICAL.Component(ICAL.parse(raw));
	const master = masterOf(comp);
	if (!master) throw new Error('The stored calendar resource contains no VEVENT.');
	const dtstart = master.getFirstProperty('dtstart');
	const tzid = dtstart?.getParameter('tzid') as string | undefined;

	const slot = findOccurrence(master, tzid, recurrenceId);
	if (!slot) {
		throw new Error(
			`No occurrence of this series starts at ${recurrenceId}. Use the "recurrenceId" value from a read operation.`,
		);
	}

	master.addProperty(dateLike('exdate', dtstart, slot, master));

	for (const override of comp.getAllSubcomponents('vevent')) {
		if (!override.hasProperty('recurrence-id')) continue;
		const rid = override.getFirstProperty('recurrence-id')?.getFirstValue();
		if (formatEventTime(rid, tzid) === recurrenceId) comp.removeSubcomponent(override);
	}

	bumpRevision(master);
	return `${comp.toString()}\r\n`;
}

/**
 * Change a single occurrence by writing a RECURRENCE-ID override beside the
 * master, or updating the override already there.
 *
 * A new override starts as a copy of the master so the occurrence keeps the
 * series' details, minus the recurrence properties themselves — an override
 * that carried the RRULE would define a second series.
 */
export function patchOccurrence(
	raw: string,
	recurrenceId: string,
	patch: PatchEventInput,
): string {
	const comp = new ICAL.Component(ICAL.parse(raw));
	const master = masterOf(comp);
	if (!master) throw new Error('The stored calendar resource contains no VEVENT.');
	const dtstart = master.getFirstProperty('dtstart');
	const tzid = dtstart?.getParameter('tzid') as string | undefined;

	let override = comp
		.getAllSubcomponents('vevent')
		.find(
			(v: any) =>
				v.hasProperty('recurrence-id') &&
				formatEventTime(v.getFirstProperty('recurrence-id')?.getFirstValue(), tzid) ===
					recurrenceId,
		);

	if (!override) {
		const slot = findOccurrence(master, tzid, recurrenceId);
		if (!slot) {
			throw new Error(
				`No occurrence of this series starts at ${recurrenceId}. Use the "recurrenceId" value from a read operation.`,
			);
		}
		override = new ICAL.Component(ICAL.parse(master.toString()));
		for (const name of ['rrule', 'rdate', 'exdate']) override.removeAllProperties(name);
		override.addProperty(dateLike('recurrence-id', dtstart, slot, override));

		// Start the override at the slot the rule generated, keeping the series'
		// duration, so a patch that only changes the title leaves the time alone.
		const details = new ICAL.Event(master).getOccurrenceDetails(slot);
		override.removeAllProperties('dtstart');
		override.removeAllProperties('dtend');
		override.addProperty(dateLike('dtstart', dtstart, details.startDate, override));
		override.addProperty(dateLike('dtend', dtstart, details.endDate, override));
		comp.addSubcomponent(override);
	}

	applyPatchFields(override, patch);
	bumpRevision(override);
	return `${comp.toString()}\r\n`;
}

/**
 * The recurrence rule of the series master, if the object holds one.
 *
 * Used to recognise that a write would hit an entire series rather than the
 * single event the caller had in mind: every occurrence shares one UID and one
 * resource, so a delete by UID removes all of them.
 */
export function seriesRecurrenceRule(raw: string): string | undefined {
	try {
		const comp = new ICAL.Component(ICAL.parse(raw));
		const vevents = comp.getAllSubcomponents('vevent');
		const master = vevents.find((v: any) => !v.hasProperty('recurrence-id'));
		const rule = master?.getFirstProperty('rrule')?.getFirstValue();
		return rule ? String(rule) : undefined;
	} catch {
		return undefined;
	}
}

// Guard rails for pathological series (an RRULE with no UNTIL/COUNT over a wide
// window, or a corrupt rule that fails to advance).
const MAX_OCCURRENCES_PER_OBJECT = 1000;
const MAX_ITERATIONS_PER_OBJECT = 20000;

/**
 * Turn one calendar object into the event records that fall inside a window,
 * expanding recurrence rules into individual occurrences.
 *
 * A time-range REPORT returns the whole object — the master VEVENT plus any
 * RECURRENCE-ID overrides — not the matching occurrences. Reading only the
 * master, as this node did before, reported a weekly series at its original
 * 2020 start date and made "Get Next" skip it entirely.
 *
 * Without a range, recurrence is left alone and the master is returned as-is.
 */
export function expandCalendarObject(
	raw: string,
	url: string,
	etag?: string,
	rangeStart?: Date,
	rangeEnd?: Date,
	localZone?: string,
): CalDavEvent[] {
	try {
		const comp = new ICAL.Component(ICAL.parse(raw));
		const vevents = comp.getAllSubcomponents('vevent');
		if (!vevents.length) return [];

		const masters = vevents.filter((v: any) => !v.hasProperty('recurrence-id'));
		const overrides = vevents.filter((v: any) => v.hasProperty('recurrence-id'));

		// An object can arrive holding only overrides when the server trims the
		// series to what matched. Report them as standalone events.
		if (!masters.length) {
			return overrides.map((v: any) => toCalDavEvent(v, url, etag, raw, undefined, localZone));
		}

		const out: CalDavEvent[] = [];
		for (const master of masters) {
			const event = new ICAL.Event(master);
			if (!rangeStart || !rangeEnd || !event.isRecurring()) {
				out.push(toCalDavEvent(master, url, etag, raw, undefined, localZone));
				continue;
			}
			for (const o of overrides) {
				if ((o.getFirstPropertyValue('uid') as string) === event.uid) {
					event.relateException(new ICAL.Event(o));
				}
			}

			const tzid = startTzid(master);
			const iterator = event.iterator();
			let next: any;
			let iterations = 0;
			let collected = 0;
			while ((next = iterator.next())) {
				if (++iterations > MAX_ITERATIONS_PER_OBJECT) break;
				// EXDATE and overrides are applied by getOccurrenceDetails, so the
				// details — not the raw iterator time — decide the real slot.
				const details = event.getOccurrenceDetails(next);
				const startsAt = instantOf(details.startDate, tzid);
				if (startsAt.getTime() >= rangeEnd.getTime()) break;
				const endsAt = instantOf(details.endDate, tzid);
				// Keep occurrences that overlap the window, matching how the server
				// selected the object in the first place.
				if (endsAt.getTime() <= rangeStart.getTime()) continue;
				out.push(
					toCalDavEvent(details.item.component, url, etag, raw, {
						start: details.startDate,
						end: details.endDate,
						recurrenceId: details.recurrenceId,
						tzid,
					},
					localZone,
					),
				);
				if (++collected >= MAX_OCCURRENCES_PER_OBJECT) break;
			}
		}
		return out;
	} catch {
		return [];
	}
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/**
 * A calendar-query that asks only which resource holds a given UID. No
 * calendar-data is requested — we want the href, not the event.
 */
export function buildUidQueryReport(uid: string): string {
	return `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:prop-filter name="UID">
          <c:text-match collation="i;octet">${escapeXml(uid)}</c:text-match>
        </c:prop-filter>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

/**
 * Find the resource URL of a single event.
 *
 * A UID is not a filename. Only events this node created live at
 * <calendar>/<uid>.ics — anything added from a calendar app is stored under a
 * name the server chose, so addressing it by UID used to 404.
 *
 * Order of preference:
 *   1. an explicit URL, as returned in the "url" field of every read operation
 *   2. a UID lookup via calendar-query
 *   3. the historical <uid>.ics convention, so servers that reject the query
 *      still work for events this node wrote
 */
export async function resolveEventUrl(
	this: RequestCtx,
	calendarUrl: string,
	uid: string,
	explicitUrl?: string,
	serverUrl?: string,
): Promise<string> {
	const explicit = (explicitUrl ?? '').trim();
	if (explicit) return absoluteUrl(explicit, serverUrl || calendarUrl);

	const logger = (this as IExecuteFunctions).logger;
	if (uid) {
		try {
			const resp = await davRequest.call(this, 'REPORT', calendarUrl, buildUidQueryReport(uid), {
				Depth: '1',
				'Content-Type': 'application/xml; charset=utf-8',
			});
			const hrefs = extractResponses(resp.body)
				.map((r) => r.href)
				.filter(Boolean)
				.map(String);
			if (hrefs.length > 1) {
				logger?.debug(`[CalDAV] UID ${uid} matched ${hrefs.length} resources; using the first`);
			}
			if (hrefs.length) return absoluteUrl(hrefs[0], serverUrl || calendarUrl);
			logger?.debug(`[CalDAV] UID ${uid} not found by query; falling back to <uid>.ics`);
		} catch (e) {
			logger?.debug(`[CalDAV] UID lookup failed (${(e as Error).message}); falling back`);
		}
	}
	return `${calendarUrl}${encodeURIComponent(uid)}.ics`;
}

/**
 * Drop the verbose `raw` payload. A recurring series repeats the same full
 * VCALENDAR on every expanded occurrence, which is pure noise for most
 * workflows and burns context when the node is used as an AI Agent tool.
 */
export function simplifyEvent(event: CalDavEvent): Omit<CalDavEvent, 'raw'> {
	const copy = { ...event };
	delete copy.raw;
	return copy;
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
 *
 * Pass the queried window as rangeStart/rangeEnd to have recurring series
 * expanded into their individual occurrences; omit it to get series masters.
 */
export function parseCalendarQueryResponse(
	xml: string,
	calendarUrl: string,
	serverUrl: string,
	rangeStart?: Date,
	rangeEnd?: Date,
	localZone?: string,
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
		events.push(...expandCalendarObject(raw, url, etag || undefined, rangeStart, rangeEnd, localZone));
	}
	return events;
}
