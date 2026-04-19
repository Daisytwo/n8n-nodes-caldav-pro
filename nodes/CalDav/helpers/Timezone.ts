/**
 * VTIMEZONE generation (RFC 5545 §3.6.5) for IANA timezones.
 *
 * Approach:
 *   - Determine the standard/daylight offsets by sampling January and July.
 *   - If they differ, emit DAYLIGHT + STANDARD sub-components with a
 *     ruleset inferred from the region (EU, US/CA/MX, AU/NZ, CL, BR, ...).
 *   - If they match, emit a single STANDARD component with no RRULE.
 *   - UTC is emitted as a trivial UTC block.
 *
 * The generated VTIMEZONE is portable enough for Google Calendar, Apple
 * Calendar, Outlook, Thunderbird, Radicale, Baikal, SOGo, Nextcloud.
 */

export interface TimezoneInfo {
	tzid: string;
	standardOffsetMinutes: number;
	daylightOffsetMinutes: number | null; // null => no DST
}

// -----------------------------------------------------------------------------
// Offset sampling
// -----------------------------------------------------------------------------

/**
 * Returns the UTC offset (in minutes, east of UTC is positive) that an IANA
 * timezone has at a given instant.
 */
export function getOffsetMinutes(tzid: string, sample: Date): number {
	// Render the sample in both UTC and the target zone and diff them.
	const dtf = new Intl.DateTimeFormat('en-US', {
		timeZone: tzid,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
	});
	const parts = dtf.formatToParts(sample).reduce<Record<string, string>>((acc, p) => {
		if (p.type !== 'literal') acc[p.type] = p.value;
		return acc;
	}, {});
	const asUTC = Date.UTC(
		Number(parts.year),
		Number(parts.month) - 1,
		Number(parts.day),
		parts.hour === '24' ? 0 : Number(parts.hour),
		Number(parts.minute),
		Number(parts.second),
	);
	return Math.round((asUTC - sample.getTime()) / 60000);
}

export function detectTimezoneInfo(tzid: string, year?: number): TimezoneInfo {
	const y = year ?? new Date().getUTCFullYear();
	const winter = new Date(Date.UTC(y, 0, 15, 12, 0, 0));
	const summer = new Date(Date.UTC(y, 6, 15, 12, 0, 0));
	const winterOffset = getOffsetMinutes(tzid, winter);
	const summerOffset = getOffsetMinutes(tzid, summer);
	if (winterOffset === summerOffset) {
		return { tzid, standardOffsetMinutes: winterOffset, daylightOffsetMinutes: null };
	}
	// Northern hemisphere: winter is standard. Southern hemisphere: summer is standard.
	const standard = Math.min(winterOffset, summerOffset);
	const daylight = Math.max(winterOffset, summerOffset);
	return { tzid, standardOffsetMinutes: standard, daylightOffsetMinutes: daylight };
}

// -----------------------------------------------------------------------------
// Offset / region / rules
// -----------------------------------------------------------------------------

function formatOffset(minutes: number): string {
	const sign = minutes < 0 ? '-' : '+';
	const abs = Math.abs(minutes);
	const h = Math.floor(abs / 60);
	const m = abs % 60;
	return `${sign}${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}00`;
}

interface DstRuleset {
	// DAYLIGHT begins
	dstStart: { month: number; byday: string; at: string };
	// STANDARD begins
	dstEnd: { month: number; byday: string; at: string };
}

/**
 * Pick a DST ruleset based on the timezone identifier prefix.
 * Covers the dominant rules for zones that observe DST.
 */
function guessDstRules(tzid: string): DstRuleset {
	const id = tzid.toLowerCase();

	// European Union: last Sunday of March @ 01:00 UTC, last Sunday of October @ 01:00 UTC
	if (id.startsWith('europe/') || id === 'atlantic/canary' || id === 'atlantic/faroe') {
		return {
			dstStart: { month: 3, byday: '-1SU', at: '020000' },
			dstEnd: { month: 10, byday: '-1SU', at: '030000' },
		};
	}

	// United States, Canada, most of Mexico (post-2007): 2nd Sun March -> 1st Sun November
	if (
		id.startsWith('america/') ||
		id === 'atlantic/bermuda' ||
		id === 'pacific/honolulu' // no DST anyway, will fall through to single-component
	) {
		return {
			dstStart: { month: 3, byday: '2SU', at: '020000' },
			dstEnd: { month: 11, byday: '1SU', at: '020000' },
		};
	}

	// Australia (most): 1st Sun October -> 1st Sun April
	if (id.startsWith('australia/')) {
		return {
			dstStart: { month: 10, byday: '1SU', at: '020000' },
			dstEnd: { month: 4, byday: '1SU', at: '030000' },
		};
	}

	// New Zealand: last Sun September -> 1st Sun April
	if (id === 'pacific/auckland' || id === 'pacific/chatham') {
		return {
			dstStart: { month: 9, byday: '-1SU', at: '020000' },
			dstEnd: { month: 4, byday: '1SU', at: '030000' },
		};
	}

	// Chile: 1st Sun September -> 1st Sun April
	if (id === 'america/santiago' || id === 'pacific/easter') {
		return {
			dstStart: { month: 9, byday: '1SU', at: '000000' },
			dstEnd: { month: 4, byday: '1SU', at: '000000' },
		};
	}

	// Fallback: EU-style. Good enough for most other observers and marked
	// as DST-only hint — real transitions depend on the year.
	return {
		dstStart: { month: 3, byday: '-1SU', at: '020000' },
		dstEnd: { month: 10, byday: '-1SU', at: '030000' },
	};
}

// -----------------------------------------------------------------------------
// VTIMEZONE block assembly
// -----------------------------------------------------------------------------

/**
 * Build a VTIMEZONE block (as raw lines without line folding; the caller
 * folds via `joinICal`). Pass the already detected info to avoid recomputing.
 */
export function buildVTimezone(tzid: string, info?: TimezoneInfo): string[] {
	// UTC is a trivial special case
	if (tzid === 'UTC' || tzid === 'Etc/UTC') {
		return [
			'BEGIN:VTIMEZONE',
			'TZID:UTC',
			'BEGIN:STANDARD',
			'DTSTART:19700101T000000',
			'TZOFFSETFROM:+0000',
			'TZOFFSETTO:+0000',
			'TZNAME:UTC',
			'END:STANDARD',
			'END:VTIMEZONE',
		];
	}

	const resolved = info ?? detectTimezoneInfo(tzid);
	const lines: string[] = ['BEGIN:VTIMEZONE', `TZID:${tzid}`];

	if (resolved.daylightOffsetMinutes === null) {
		// No DST: single STANDARD component
		const off = formatOffset(resolved.standardOffsetMinutes);
		lines.push(
			'BEGIN:STANDARD',
			'DTSTART:19700101T000000',
			`TZOFFSETFROM:${off}`,
			`TZOFFSETTO:${off}`,
			`TZNAME:${tzid.split('/').pop() ?? tzid}`,
			'END:STANDARD',
		);
	} else {
		const rules = guessDstRules(tzid);
		const std = formatOffset(resolved.standardOffsetMinutes);
		const dst = formatOffset(resolved.daylightOffsetMinutes);

		lines.push(
			'BEGIN:DAYLIGHT',
			`DTSTART:19700${rules.dstStart.month < 10 ? '' : ''}${String(
				rules.dstStart.month,
			).padStart(2, '0')}08T${rules.dstStart.at}`,
			`TZOFFSETFROM:${std}`,
			`TZOFFSETTO:${dst}`,
			`RRULE:FREQ=YEARLY;BYMONTH=${rules.dstStart.month};BYDAY=${rules.dstStart.byday}`,
			'TZNAME:DST',
			'END:DAYLIGHT',
			'BEGIN:STANDARD',
			`DTSTART:19700${String(rules.dstEnd.month).padStart(2, '0')}08T${rules.dstEnd.at}`,
			`TZOFFSETFROM:${dst}`,
			`TZOFFSETTO:${std}`,
			`RRULE:FREQ=YEARLY;BYMONTH=${rules.dstEnd.month};BYDAY=${rules.dstEnd.byday}`,
			'TZNAME:STD',
			'END:STANDARD',
		);
	}

	lines.push('END:VTIMEZONE');
	return lines;
}

// -----------------------------------------------------------------------------
// Local date-time formatting in a given timezone
// -----------------------------------------------------------------------------

/**
 * Convert a JS Date (an absolute instant) to a local YYYYMMDDTHHmmss string
 * in a given timezone. The result has no Z suffix; it is meant to be paired
 * with TZID=<tzid>.
 */
export function formatLocalDateTime(date: Date, tzid: string): string {
	const dtf = new Intl.DateTimeFormat('en-US', {
		timeZone: tzid,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
	});
	const parts = dtf.formatToParts(date).reduce<Record<string, string>>((acc, p) => {
		if (p.type !== 'literal') acc[p.type] = p.value;
		return acc;
	}, {});
	const hour = parts.hour === '24' ? '00' : parts.hour;
	return `${parts.year}${parts.month}${parts.day}T${hour}${parts.minute}${parts.second}`;
}

/** YYYYMMDD for DATE values (all-day events). */
export function formatDateOnly(date: Date, tzid: string): string {
	return formatLocalDateTime(date, tzid).slice(0, 8);
}

/** UTC timestamp as YYYYMMDDTHHmmssZ (used for DTSTAMP/CREATED/LAST-MODIFIED). */
export function formatUtcStamp(date: Date): string {
	const iso = date.toISOString();
	return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}
