/**
 * Recurrence expansion for RRULE within an explicit date window.
 * Supports the subset the node creates: FREQ, INTERVAL, COUNT, UNTIL, BYDAY.
 */

import { ParsedEvent } from './ICal';

export interface ExpandedOccurrence {
	uid: string;
	start: Date;
	end: Date;
	summary?: string;
	description?: string;
	location?: string;
	allDay: boolean;
	recurring: boolean;
	originalStart: Date;
	rrule?: string;
	alarmTriggerMinutes?: number | null;
}

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * Parse an iCal-style date/datetime:
 *   "YYYYMMDD"           -> date-only (all-day)
 *   "YYYYMMDDTHHmmss"    -> floating/local time
 *   "YYYYMMDDTHHmmssZ"   -> UTC
 *
 * Returns a JS Date (absolute instant). For floating/local values, the TZID is
 * used to anchor the wall-clock time. For DATE values the time is 00:00 in
 * the TZID (or UTC if no TZID).
 */
export function parseICalDate(value: string, tzid?: string): { date: Date; allDay: boolean } {
	const v = value.trim();
	if (!v) throw new Error('Empty iCal date value');

	// All-day DATE value
	if (/^\d{8}$/.test(v)) {
		const y = Number(v.slice(0, 4));
		const m = Number(v.slice(4, 6));
		const d = Number(v.slice(6, 8));
		// Interpret midnight in tzid (or UTC) as the instant
		const ms = Date.UTC(y, m - 1, d, 0, 0, 0);
		return { date: new Date(ms), allDay: true };
	}

	// DATE-TIME value
	const dtMatch = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
	if (!dtMatch) throw new Error(`Unparseable iCal date: ${v}`);
	const [, y, mo, d, h, mi, s, z] = dtMatch;
	const year = Number(y);
	const month = Number(mo);
	const day = Number(d);
	const hour = Number(h);
	const minute = Number(mi);
	const second = Number(s);

	if (z === 'Z') {
		return {
			date: new Date(Date.UTC(year, month - 1, day, hour, minute, second)),
			allDay: false,
		};
	}

	// TZID or floating time: anchor in the provided timezone
	if (tzid) {
		const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
		const offset = getOffsetMinutesAt(tzid, new Date(asUtc));
		return { date: new Date(asUtc - offset * 60 * 1000), allDay: false };
	}
	// Floating time with no zone: treat as UTC
	return {
		date: new Date(Date.UTC(year, month - 1, day, hour, minute, second)),
		allDay: false,
	};
}

function getOffsetMinutesAt(tzid: string, sample: Date): number {
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

// -----------------------------------------------------------------------------
// RRULE parsing
// -----------------------------------------------------------------------------

export interface ParsedRRule {
	freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
	interval: number;
	count?: number;
	until?: Date;
	byDay?: string[]; // raw tokens (e.g. "MO", "2SU", "-1FR")
}

export function parseRRule(rrule: string): ParsedRRule | null {
	if (!rrule) return null;
	const map: Record<string, string> = {};
	rrule.split(';').forEach((kv) => {
		const [k, v] = kv.split('=');
		if (k && v !== undefined) map[k.toUpperCase()] = v;
	});
	const freq = (map.FREQ ?? '').toUpperCase();
	if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;

	const parsed: ParsedRRule = {
		freq: freq as ParsedRRule['freq'],
		interval: map.INTERVAL ? Math.max(1, parseInt(map.INTERVAL, 10)) : 1,
	};

	if (map.COUNT) parsed.count = Math.max(1, parseInt(map.COUNT, 10));
	if (map.UNTIL) parsed.until = parseICalDate(map.UNTIL).date;
	if (map.BYDAY)
		parsed.byDay = map.BYDAY.split(',')
			.map((x) => x.trim().toUpperCase())
			.filter(Boolean);

	return parsed;
}

// -----------------------------------------------------------------------------
// Expansion
// -----------------------------------------------------------------------------

function addDaysUTC(date: Date, days: number): Date {
	return new Date(date.getTime() + days * 86400000);
}

function addMonthsUTC(date: Date, months: number): Date {
	const d = new Date(date.getTime());
	const targetMonth = d.getUTCMonth() + months;
	d.setUTCMonth(targetMonth);
	return d;
}

function addYearsUTC(date: Date, years: number): Date {
	const d = new Date(date.getTime());
	d.setUTCFullYear(d.getUTCFullYear() + years);
	return d;
}

/**
 * Expand a parsed event within [rangeStart, rangeEnd]. If the event is not
 * recurring, it is returned as-is (filtered by the range).
 */
export function expandEvent(
	event: ParsedEvent,
	rangeStart: Date,
	rangeEnd: Date,
	options: { maxOccurrences?: number } = {},
): ExpandedOccurrence[] {
	if (!event.start) return [];
	const max = options.maxOccurrences ?? 1000;

	const { date: startDate, allDay } = parseICalDate(event.start, event.tzid);
	let endDate: Date;
	if (event.end) {
		endDate = parseICalDate(event.end, event.tzid).date;
	} else {
		// Default 1h duration for timed events, 1d for all-day
		endDate = allDay
			? new Date(startDate.getTime() + 86400000)
			: new Date(startDate.getTime() + 3600000);
	}
	const duration = endDate.getTime() - startDate.getTime();

	const base = (occurrenceStart: Date): ExpandedOccurrence => ({
		uid: event.uid,
		start: occurrenceStart,
		end: new Date(occurrenceStart.getTime() + duration),
		summary: event.summary,
		description: event.description,
		location: event.location,
		allDay,
		recurring: Boolean(event.rrule),
		originalStart: startDate,
		rrule: event.rrule,
		alarmTriggerMinutes: event.alarmTriggerMinutes ?? null,
	});

	const rrule = event.rrule ? parseRRule(event.rrule) : null;
	if (!rrule) {
		// Single occurrence: include if overlapping the window
		if (endDate.getTime() < rangeStart.getTime() || startDate.getTime() > rangeEnd.getTime()) {
			return [];
		}
		return [base(startDate)];
	}

	const occurrences: ExpandedOccurrence[] = [];
	let current = new Date(startDate.getTime());
	let emitted = 0;
	let iterations = 0;
	const hardCap = Math.max(max * 4, 4000); // guard

	const weekDayIndexes = rrule.byDay
		? rrule.byDay
				.map((token) => {
					const m = /^([+-]?\d*)(MO|TU|WE|TH|FR|SA|SU)$/.exec(token);
					if (!m) return null;
					return { ordinal: m[1] ? parseInt(m[1], 10) : 0, weekday: WEEKDAY_CODES.indexOf(m[2]) };
				})
				.filter((x): x is { ordinal: number; weekday: number } => x !== null)
		: null;

	while (iterations++ < hardCap) {
		if (rrule.until && current.getTime() > rrule.until.getTime()) break;
		if (rrule.count !== undefined && emitted >= rrule.count) break;
		if (current.getTime() > rangeEnd.getTime()) {
			// Still advance to check for COUNT termination — but for DAILY+ we can stop early
			break;
		}

		let occurrencesThisStep: Date[] = [current];

		// For WEEKLY with BYDAY, expand each matching day in the week of `current`
		if (rrule.freq === 'WEEKLY' && weekDayIndexes && weekDayIndexes.length) {
			occurrencesThisStep = [];
			const baseDow = current.getUTCDay();
			for (const wd of weekDayIndexes) {
				const delta = wd.weekday - baseDow;
				const candidate = addDaysUTC(current, delta);
				if (candidate.getTime() < startDate.getTime()) continue;
				occurrencesThisStep.push(candidate);
			}
			occurrencesThisStep.sort((a, b) => a.getTime() - b.getTime());
		}

		for (const occ of occurrencesThisStep) {
			if (rrule.until && occ.getTime() > rrule.until.getTime()) continue;
			if (rrule.count !== undefined && emitted >= rrule.count) break;
			const occEnd = new Date(occ.getTime() + duration);
			if (occEnd.getTime() >= rangeStart.getTime() && occ.getTime() <= rangeEnd.getTime()) {
				occurrences.push(base(occ));
				if (occurrences.length >= max) return occurrences;
			}
			emitted++;
		}

		// Advance the base pointer
		switch (rrule.freq) {
			case 'DAILY':
				current = addDaysUTC(current, rrule.interval);
				break;
			case 'WEEKLY':
				current = addDaysUTC(current, 7 * rrule.interval);
				break;
			case 'MONTHLY':
				current = addMonthsUTC(current, rrule.interval);
				break;
			case 'YEARLY':
				current = addYearsUTC(current, rrule.interval);
				break;
		}
	}

	return occurrences;
}
