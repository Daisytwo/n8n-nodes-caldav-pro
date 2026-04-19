/**
 * iCal VCALENDAR / VEVENT / VALARM / RRULE assembly and parsing.
 *
 * Only the subset required by the node is covered, but it is RFC-5545
 * compliant in what it emits: CRLF line endings, line folding, TZID
 * references, UTC stamps and correct property ordering.
 */

import { escapeICalText, foldICalLine, joinICal } from './Utils';
import {
	buildVTimezone,
	formatDateOnly,
	formatLocalDateTime,
	formatUtcStamp,
} from './Timezone';

// -----------------------------------------------------------------------------
// Event input types
// -----------------------------------------------------------------------------

export type RecurrenceFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
export type RecurrenceEndType = 'count' | 'until' | 'never';

export interface RecurrenceOptions {
	frequency: RecurrenceFrequency;
	interval: number;
	endType: RecurrenceEndType;
	count?: number;
	until?: Date;
	byDay?: string; // e.g. "MO,TU,WE,TH,FR"
}

export interface EventInput {
	uid: string;
	title: string;
	start: Date;
	end: Date;
	location?: string;
	description?: string;
	allDay?: boolean;
	reminderMinutes?: number; // 0 or undefined => no alarm
	recurrence?: RecurrenceOptions;
}

export interface ParsedEvent {
	uid: string;
	summary?: string;
	description?: string;
	location?: string;
	start?: string;
	end?: string;
	allDay: boolean;
	tzid?: string;
	rrule?: string;
	recurrenceId?: string;
	status?: string;
	created?: string;
	lastModified?: string;
	sequence?: number;
	alarmTriggerMinutes?: number | null;
	raw: string;
}

// -----------------------------------------------------------------------------
// Builders
// -----------------------------------------------------------------------------

export function buildRRule(r: RecurrenceOptions): string {
	const parts: string[] = [`FREQ=${r.frequency}`];
	const interval = Number.isFinite(r.interval) && r.interval > 0 ? Math.floor(r.interval) : 1;
	if (interval !== 1) parts.push(`INTERVAL=${interval}`);
	if (r.byDay && r.byDay.trim()) {
		const cleaned = r.byDay
			.split(',')
			.map((d) => d.trim().toUpperCase())
			.filter((d) => /^[+-]?\d*(MO|TU|WE|TH|FR|SA|SU)$/.test(d))
			.join(',');
		if (cleaned) parts.push(`BYDAY=${cleaned}`);
	}
	if (r.endType === 'count' && r.count && r.count > 0) {
		parts.push(`COUNT=${Math.floor(r.count)}`);
	} else if (r.endType === 'until' && r.until) {
		parts.push(`UNTIL=${formatUtcStamp(r.until)}`);
	}
	return parts.join(';');
}

export function buildVAlarm(minutesBefore: number, summary: string): string[] {
	const mins = Math.max(0, Math.floor(minutesBefore));
	return [
		'BEGIN:VALARM',
		'ACTION:DISPLAY',
		`DESCRIPTION:${escapeICalText(summary)}`,
		`TRIGGER:-PT${mins}M`,
		'END:VALARM',
	];
}

/**
 * Compose a full VCALENDAR document for a single event, in the supplied
 * timezone. VTIMEZONE is emitted before VEVENT as required by RFC 5545.
 */
export function buildVCalendarForEvent(event: EventInput, tzid: string): string {
	const now = new Date();
	const lines: string[] = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//n8n-nodes-caldav-pro//1.1.0//EN',
		'CALSCALE:GREGORIAN',
	];

	// VTIMEZONE only when the event has a wall-clock time (not all-day DATE values)
	if (!event.allDay && tzid !== 'UTC' && tzid !== 'Etc/UTC') {
		lines.push(...buildVTimezone(tzid));
	}

	lines.push('BEGIN:VEVENT');
	lines.push(`UID:${event.uid}`);
	lines.push(`DTSTAMP:${formatUtcStamp(now)}`);
	lines.push(`CREATED:${formatUtcStamp(now)}`);
	lines.push(`LAST-MODIFIED:${formatUtcStamp(now)}`);
	lines.push(`SUMMARY:${escapeICalText(event.title)}`);
	if (event.description) lines.push(`DESCRIPTION:${escapeICalText(event.description)}`);
	if (event.location) lines.push(`LOCATION:${escapeICalText(event.location)}`);

	if (event.allDay) {
		const endInclusive = new Date(event.end.getTime());
		// iCal DTEND on all-day events is exclusive; if start==end, bump by one day.
		if (endInclusive.getTime() <= event.start.getTime()) {
			endInclusive.setUTCDate(endInclusive.getUTCDate() + 1);
		} else {
			// DATE values: if the user supplied a clock time, strip it and bump end to next day
			endInclusive.setUTCDate(endInclusive.getUTCDate() + 1);
		}
		lines.push(`DTSTART;VALUE=DATE:${formatDateOnly(event.start, tzid)}`);
		lines.push(`DTEND;VALUE=DATE:${formatDateOnly(endInclusive, tzid)}`);
	} else {
		lines.push(`DTSTART;TZID=${tzid}:${formatLocalDateTime(event.start, tzid)}`);
		lines.push(`DTEND;TZID=${tzid}:${formatLocalDateTime(event.end, tzid)}`);
	}

	if (event.recurrence && event.recurrence.endType !== 'never') {
		lines.push(`RRULE:${buildRRule(event.recurrence)}`);
	} else if (event.recurrence && event.recurrence.endType === 'never') {
		// still emit (no COUNT/UNTIL) so the event recurs forever
		lines.push(`RRULE:${buildRRule(event.recurrence)}`);
	}

	if (event.reminderMinutes && event.reminderMinutes > 0) {
		lines.push(...buildVAlarm(event.reminderMinutes, event.title));
	}

	lines.push('END:VEVENT');
	lines.push('END:VCALENDAR');

	return joinICal(lines);
}

// -----------------------------------------------------------------------------
// Parsing (tolerant)
// -----------------------------------------------------------------------------

/**
 * Un-fold iCal: continuation lines start with a single space or tab.
 */
export function unfold(raw: string): string {
	return raw.replace(/\r?\n[ \t]/g, '');
}

export function unescapeText(value: string): string {
	return value
		.replace(/\\n/gi, '\n')
		.replace(/\\,/g, ',')
		.replace(/\\;/g, ';')
		.replace(/\\\\/g, '\\');
}

/**
 * Very small iCal parser. Splits nested blocks (VEVENT, VALARM, VTIMEZONE) and
 * returns the VEVENT list as structured objects. Only properties required by
 * this node are surfaced — the raw block is retained for power users.
 */
export function parseVEvents(raw: string): ParsedEvent[] {
	if (!raw) return [];
	const text = unfold(raw);
	const events: ParsedEvent[] = [];

	// Split per top-level VEVENT
	const veventRegex = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/g;
	let match: RegExpExecArray | null;
	while ((match = veventRegex.exec(text)) !== null) {
		const body = match[1];
		const rawBlock = match[0];
		const event: ParsedEvent = {
			uid: '',
			allDay: false,
			raw: rawBlock + 'END:VEVENT',
		};

		// Extract an optional VALARM trigger (first one only)
		const alarmMatch = /BEGIN:VALARM([\s\S]*?)END:VALARM/.exec(body);
		let alarmBlock = '';
		let stripped = body;
		if (alarmMatch) {
			alarmBlock = alarmMatch[1];
			stripped = body.replace(alarmMatch[0], '');
		}

		const lines = stripped
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean);

		for (const line of lines) {
			const colon = line.indexOf(':');
			if (colon < 0) continue;
			const left = line.slice(0, colon);
			const value = line.slice(colon + 1);
			const [propName, ...params] = left.split(';');
			const prop = propName.toUpperCase();
			const paramMap: Record<string, string> = {};
			for (const p of params) {
				const eq = p.indexOf('=');
				if (eq > 0) paramMap[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
			}

			switch (prop) {
				case 'UID':
					event.uid = value;
					break;
				case 'SUMMARY':
					event.summary = unescapeText(value);
					break;
				case 'DESCRIPTION':
					event.description = unescapeText(value);
					break;
				case 'LOCATION':
					event.location = unescapeText(value);
					break;
				case 'DTSTART':
					event.start = value;
					if (paramMap.VALUE === 'DATE') event.allDay = true;
					if (paramMap.TZID) event.tzid = paramMap.TZID;
					break;
				case 'DTEND':
					event.end = value;
					break;
				case 'RRULE':
					event.rrule = value;
					break;
				case 'RECURRENCE-ID':
					event.recurrenceId = value;
					break;
				case 'STATUS':
					event.status = value;
					break;
				case 'CREATED':
					event.created = value;
					break;
				case 'LAST-MODIFIED':
					event.lastModified = value;
					break;
				case 'SEQUENCE':
					event.sequence = Number(value) || 0;
					break;
			}
		}

		if (alarmBlock) {
			const trig = /TRIGGER(?:;[^:]*)?:(-?P[^\r\n]*)/i.exec(alarmBlock);
			if (trig) {
				event.alarmTriggerMinutes = parseTriggerToMinutes(trig[1]);
			}
		} else {
			event.alarmTriggerMinutes = null;
		}

		if (event.uid) events.push(event);
	}

	return events;
}

export function parseTriggerToMinutes(trigger: string): number | null {
	// Examples: -PT15M, -PT1H, -P1D, PT0S
	const m = /^(-)?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(trigger.trim());
	if (!m) return null;
	const sign = m[1] ? -1 : 1;
	const d = Number(m[2] ?? 0);
	const h = Number(m[3] ?? 0);
	const min = Number(m[4] ?? 0);
	const s = Number(m[5] ?? 0);
	const total = d * 24 * 60 + h * 60 + min + Math.floor(s / 60);
	// Reminder minutes are conventionally positive (minutes BEFORE start).
	// Explicitly guard against -0 when total is 0 and sign is positive.
	if (total === 0) return 0;
	return sign === -1 ? total : -total;
}

// -----------------------------------------------------------------------------
// Convenience re-exports
// -----------------------------------------------------------------------------

export { foldICalLine };
