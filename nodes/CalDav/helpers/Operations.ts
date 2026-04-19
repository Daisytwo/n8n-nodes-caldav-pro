/**
 * Business logic for each CalDAV operation. Both the standard and the
 * AI Tool node delegate here after normalising their input, so that the
 * behaviour is identical.
 */

import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { randomUUID } from 'crypto';

import {
	calendarQuery,
	deleteEvent as deleteCalDavEvent,
	freeBusyQuery,
	getEvent as getCalDavEvent,
	putEvent,
	CalDavCredentials,
} from './CalDavClient';
import {
	buildVCalendarForEvent,
	EventInput,
	parseVEvents,
	RecurrenceEndType,
	RecurrenceFrequency,
	RecurrenceOptions,
} from './ICal';
import { expandEvent, ExpandedOccurrence } from './Recurrence';
import {
	pickParam,
	requireString,
	sanitizeUid,
} from './Utils';

// -----------------------------------------------------------------------------
// Input coercion helpers
// -----------------------------------------------------------------------------

function parseDateLike(value: unknown, field: string): Date {
	if (value === undefined || value === null || value === '') {
		throw new Error(`Parameter "${field}" is required`);
	}
	if (value instanceof Date) {
		if (isNaN(value.getTime())) throw new Error(`Parameter "${field}" is not a valid date`);
		return value;
	}
	if (typeof value === 'number') {
		const d = new Date(value);
		if (isNaN(d.getTime())) throw new Error(`Parameter "${field}" is not a valid date`);
		return d;
	}
	const s = String(value).trim();
	// Bare YYYY-MM-DD -> interpret as midnight UTC
	if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
		const d = new Date(`${s}T00:00:00Z`);
		if (isNaN(d.getTime())) throw new Error(`Parameter "${field}" is not a valid date`);
		return d;
	}
	const d = new Date(s);
	if (isNaN(d.getTime())) {
		throw new Error(`Parameter "${field}" is not a valid date: "${s}"`);
	}
	return d;
}

function toBoolean(value: unknown, dflt: boolean): boolean {
	if (value === undefined || value === null || value === '') return dflt;
	if (typeof value === 'boolean') return value;
	if (typeof value === 'number') return value !== 0;
	const s = String(value).trim().toLowerCase();
	if (['true', 'yes', '1', 'y', 'on'].includes(s)) return true;
	if (['false', 'no', '0', 'n', 'off'].includes(s)) return false;
	return dflt;
}

function toInt(value: unknown, dflt: number): number {
	if (value === undefined || value === null || value === '') return dflt;
	const n = typeof value === 'number' ? value : parseInt(String(value), 10);
	return Number.isFinite(n) ? n : dflt;
}

function normalizeFrequency(value: unknown): RecurrenceFrequency {
	const s = String(value ?? '').trim().toUpperCase();
	if (['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(s)) return s as RecurrenceFrequency;
	return 'WEEKLY';
}

function normalizeEndType(value: unknown): RecurrenceEndType {
	const s = String(value ?? '').trim().toLowerCase();
	if (s === 'count' || s === 'until' || s === 'never') return s;
	return 'never';
}

function serializeOccurrence(o: ExpandedOccurrence): IDataObject {
	return {
		uid: o.uid,
		summary: o.summary,
		description: o.description,
		location: o.location,
		start: o.start.toISOString(),
		end: o.end.toISOString(),
		allDay: o.allDay,
		recurring: o.recurring,
		originalStart: o.originalStart.toISOString(),
		rrule: o.rrule,
		reminderMinutesBefore: o.alarmTriggerMinutes ?? null,
	};
}

// -----------------------------------------------------------------------------
// Operation: Get Events
// -----------------------------------------------------------------------------

export interface GetEventsParams {
	date?: string;
	startDate?: string;
	endDate?: string;
}

export async function opGetEvents(
	ctx: IExecuteFunctions,
	credentials: CalDavCredentials,
	params: Record<string, unknown>,
): Promise<IDataObject> {
	const date = pickParam<string>(params, 'date');
	let startDate = pickParam<string>(params, 'startDate');
	let endDate = pickParam<string>(params, 'endDate');

	let windowStart: Date;
	let windowEnd: Date;

	if (startDate && endDate) {
		windowStart = parseDateLike(startDate, 'Start_Date');
		windowEnd = parseDateLike(endDate, 'End_Date');
	} else if (date) {
		const d = parseDateLike(date, 'date');
		windowStart = new Date(
			Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0),
		);
		windowEnd = new Date(
			Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0),
		);
	} else if (startDate || endDate) {
		// Partial range: fill the other side
		if (startDate && !endDate) {
			windowStart = parseDateLike(startDate, 'Start_Date');
			windowEnd = new Date(windowStart.getTime() + 86400000);
		} else {
			windowEnd = parseDateLike(endDate!, 'End_Date');
			windowStart = new Date(windowEnd.getTime() - 86400000);
		}
	} else {
		// Default: today in UTC
		const now = new Date();
		windowStart = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0),
		);
		windowEnd = new Date(windowStart.getTime() + 86400000);
	}

	if (windowEnd.getTime() < windowStart.getTime()) {
		throw new Error('End_Date must be greater than or equal to Start_Date');
	}

	const resources = await calendarQuery(ctx, credentials, windowStart, windowEnd);

	const occurrences: ExpandedOccurrence[] = [];
	for (const res of resources) {
		if (!res.data) continue;
		const events = parseVEvents(res.data);
		for (const ev of events) {
			const expanded = expandEvent(ev, windowStart, windowEnd);
			occurrences.push(...expanded);
		}
	}

	// Stable chronological order
	occurrences.sort((a, b) => a.start.getTime() - b.start.getTime());

	return {
		success: true,
		operation: 'getEvents',
		rangeStart: windowStart.toISOString(),
		rangeEnd: windowEnd.toISOString(),
		count: occurrences.length,
		events: occurrences.map(serializeOccurrence),
	};
}

// -----------------------------------------------------------------------------
// Operation: Create Event
// -----------------------------------------------------------------------------

export async function opCreateEvent(
	ctx: IExecuteFunctions,
	credentials: CalDavCredentials,
	params: Record<string, unknown>,
	tzid: string,
): Promise<IDataObject> {
	const title = requireString(pickParam(params, 'eventTitle'), 'Event_Title');
	const startRaw = pickParam(params, 'startDateAndTime');
	const endRaw = pickParam(params, 'endDateAndTime');
	const allDay = toBoolean(pickParam(params, 'allDayEvent'), false);
	const location = pickParam<string>(params, 'location');
	const description = pickParam<string>(params, 'description');
	const reminder = toInt(pickParam(params, 'reminder'), 0);

	const start = parseDateLike(startRaw, 'Start_Date_and_Time');
	const end = endRaw
		? parseDateLike(endRaw, 'End_Date_and_Time')
		: new Date(start.getTime() + 3600_000);

	if (end.getTime() < start.getTime()) {
		throw new Error('End_Date_and_Time must be after Start_Date_and_Time');
	}

	// Recurrence
	let recurrence: RecurrenceOptions | undefined;
	const recurring = toBoolean(pickParam(params, 'recurringEvent'), false);
	if (recurring) {
		const endType = normalizeEndType(pickParam(params, 'recurrenceEndType'));
		recurrence = {
			frequency: normalizeFrequency(pickParam(params, 'recurrenceFrequency')),
			interval: toInt(pickParam(params, 'recurrenceInterval'), 1),
			endType,
			count:
				endType === 'count' ? toInt(pickParam(params, 'recurrenceCount'), 0) || undefined : undefined,
			until:
				endType === 'until' && pickParam(params, 'recurrenceUntil')
					? parseDateLike(pickParam(params, 'recurrenceUntil'), 'Recurrence_Until')
					: undefined,
			byDay: pickParam<string>(params, 'recurrenceByDay'),
		};
	}

	// UID: accept user-provided or generate a UUID
	const providedUid = pickParam<string>(params, 'uid');
	const uid = providedUid ? sanitizeUid(providedUid) : `${randomUUID()}@n8n-caldav`;

	const eventInput: EventInput = {
		uid,
		title,
		start,
		end,
		allDay,
		location,
		description,
		reminderMinutes: reminder,
		recurrence,
	};

	const ical = buildVCalendarForEvent(eventInput, tzid);
	const putResult = await putEvent(ctx, credentials, uid, ical, { ifNoneMatch: '*' });

	return {
		success: true,
		operation: 'createEvent',
		uid,
		etag: putResult.etag,
		href: putResult.href,
		timezone: tzid,
		event: {
			uid,
			title,
			start: start.toISOString(),
			end: end.toISOString(),
			allDay,
			location,
			description,
			reminderMinutesBefore: reminder || null,
			recurrence: recurrence ?? null,
		},
	};
}

// -----------------------------------------------------------------------------
// Operation: Update Event
// -----------------------------------------------------------------------------

export async function opUpdateEvent(
	ctx: IExecuteFunctions,
	credentials: CalDavCredentials,
	params: Record<string, unknown>,
	tzid: string,
): Promise<IDataObject> {
	const uid = sanitizeUid(requireString(pickParam(params, 'uid'), 'UID'));

	// Fetch current state so we can do a partial update
	const current = await getCalDavEvent(ctx, credentials, uid);
	if (!current) {
		throw new Error(`Event with UID "${uid}" not found`);
	}
	const [existing] = parseVEvents(current.data);
	if (!existing) {
		throw new Error(`Event with UID "${uid}" could not be parsed`);
	}

	// Carry forward existing values where no new value is supplied
	const nextTitle = pickParam<string>(params, 'eventTitle') ?? existing.summary ?? '(no title)';
	const nextLocation = pickParam<string>(params, 'location') ?? existing.location;
	const nextDescription = pickParam<string>(params, 'description') ?? existing.description;

	const startRaw = pickParam(params, 'startDateAndTime');
	const endRaw = pickParam(params, 'endDateAndTime');

	// Prefer existing start/end if the user did not supply new values
	let start: Date;
	let end: Date;
	if (startRaw) {
		start = parseDateLike(startRaw, 'Start_Date_and_Time');
	} else if (existing.start) {
		start = new Date(
			Date.UTC(
				Number(existing.start.slice(0, 4)),
				Number(existing.start.slice(4, 6)) - 1,
				Number(existing.start.slice(6, 8)),
				Number(existing.start.slice(9, 11) || '0'),
				Number(existing.start.slice(11, 13) || '0'),
				Number(existing.start.slice(13, 15) || '0'),
			),
		);
	} else {
		start = new Date();
	}
	if (endRaw) {
		end = parseDateLike(endRaw, 'End_Date_and_Time');
	} else if (existing.end) {
		end = new Date(
			Date.UTC(
				Number(existing.end.slice(0, 4)),
				Number(existing.end.slice(4, 6)) - 1,
				Number(existing.end.slice(6, 8)),
				Number(existing.end.slice(9, 11) || '0'),
				Number(existing.end.slice(11, 13) || '0'),
				Number(existing.end.slice(13, 15) || '0'),
			),
		);
	} else {
		end = new Date(start.getTime() + 3600_000);
	}

	const allDayParam = pickParam(params, 'allDayEvent');
	const allDay = allDayParam !== undefined ? toBoolean(allDayParam, false) : existing.allDay;

	const reminderParam = pickParam(params, 'reminder');
	const reminder = reminderParam !== undefined
		? toInt(reminderParam, 0)
		: existing.alarmTriggerMinutes && existing.alarmTriggerMinutes > 0
			? existing.alarmTriggerMinutes
			: 0;

	// Recurrence: only overwrite when the caller indicates intent
	let recurrence: RecurrenceOptions | undefined;
	const recurringParam = pickParam(params, 'recurringEvent');
	if (recurringParam !== undefined) {
		if (toBoolean(recurringParam, false)) {
			const endType = normalizeEndType(pickParam(params, 'recurrenceEndType'));
			recurrence = {
				frequency: normalizeFrequency(pickParam(params, 'recurrenceFrequency')),
				interval: toInt(pickParam(params, 'recurrenceInterval'), 1),
				endType,
				count:
					endType === 'count'
						? toInt(pickParam(params, 'recurrenceCount'), 0) || undefined
						: undefined,
				until:
					endType === 'until' && pickParam(params, 'recurrenceUntil')
						? parseDateLike(pickParam(params, 'recurrenceUntil'), 'Recurrence_Until')
						: undefined,
				byDay: pickParam<string>(params, 'recurrenceByDay'),
			};
		} else {
			recurrence = undefined; // explicit removal
		}
	} else if (existing.rrule) {
		// Preserve existing RRULE verbatim — parse only what we need to rebuild.
		// Simplest correct approach: keep the existing RRULE text by bypassing recurrence
		// reconstruction and appending the raw RRULE in the builder is out of scope here,
		// so we rebuild from parsed tokens.
		const m = /FREQ=([A-Z]+)/.exec(existing.rrule);
		if (m) {
			const existingFreq = normalizeFrequency(m[1]);
			const interval = /INTERVAL=(\d+)/.exec(existing.rrule);
			const count = /COUNT=(\d+)/.exec(existing.rrule);
			const until = /UNTIL=([^;]+)/.exec(existing.rrule);
			const byDay = /BYDAY=([^;]+)/.exec(existing.rrule);
			recurrence = {
				frequency: existingFreq,
				interval: interval ? Number(interval[1]) : 1,
				endType: count ? 'count' : until ? 'until' : 'never',
				count: count ? Number(count[1]) : undefined,
				until: until ? parseDateLike(`${until[1].slice(0, 8)}T${until[1].slice(9, 15) || '000000'}Z`, 'UNTIL') : undefined,
				byDay: byDay ? byDay[1] : undefined,
			};
		}
	}

	const ical = buildVCalendarForEvent(
		{
			uid,
			title: nextTitle,
			start,
			end,
			allDay,
			location: nextLocation,
			description: nextDescription,
			reminderMinutes: reminder,
			recurrence,
		},
		tzid,
	);

	const putResult = await putEvent(ctx, credentials, uid, ical, {
		ifMatch: current.etag,
	});

	return {
		success: true,
		operation: 'updateEvent',
		uid,
		etag: putResult.etag,
		href: putResult.href,
		timezone: tzid,
		event: {
			uid,
			title: nextTitle,
			start: start.toISOString(),
			end: end.toISOString(),
			allDay,
			location: nextLocation,
			description: nextDescription,
			reminderMinutesBefore: reminder || null,
			recurrence: recurrence ?? null,
		},
	};
}

// -----------------------------------------------------------------------------
// Operation: Delete Event
// -----------------------------------------------------------------------------

export async function opDeleteEvent(
	ctx: IExecuteFunctions,
	credentials: CalDavCredentials,
	params: Record<string, unknown>,
): Promise<IDataObject> {
	const uid = sanitizeUid(requireString(pickParam(params, 'uid'), 'UID'));
	const result = await deleteCalDavEvent(ctx, credentials, uid);
	return {
		success: true,
		operation: 'deleteEvent',
		uid,
		deleted: result.deleted,
		statusCode: result.statusCode,
	};
}

// -----------------------------------------------------------------------------
// Operation: Get Free/Busy
// -----------------------------------------------------------------------------

export async function opGetFreeBusy(
	ctx: IExecuteFunctions,
	credentials: CalDavCredentials,
	params: Record<string, unknown>,
): Promise<IDataObject> {
	const startRaw = pickParam(params, 'startDate');
	const endRaw = pickParam(params, 'endDate');
	const start = parseDateLike(startRaw, 'Start_Date');
	const end = parseDateLike(endRaw, 'End_Date');
	if (end.getTime() <= start.getTime()) {
		throw new Error('End_Date must be after Start_Date');
	}

	let busyRanges: Array<{ start: Date; end: Date }> = [];
	let method: 'freebusy-query' | 'calendar-query-fallback' = 'freebusy-query';

	try {
		const fb = await freeBusyQuery(ctx, credentials, start, end);
		if (!fb.fallback && fb.busy.length > 0) {
			busyRanges = fb.busy;
		} else {
			method = 'calendar-query-fallback';
		}
	} catch {
		method = 'calendar-query-fallback';
	}

	if (method === 'calendar-query-fallback') {
		const resources = await calendarQuery(ctx, credentials, start, end);
		for (const res of resources) {
			if (!res.data) continue;
			for (const ev of parseVEvents(res.data)) {
				for (const occ of expandEvent(ev, start, end)) {
					busyRanges.push({ start: occ.start, end: occ.end });
				}
			}
		}
	}

	// Merge overlapping busy ranges and clip to the query window
	busyRanges = busyRanges
		.map((r) => ({
			start: new Date(Math.max(r.start.getTime(), start.getTime())),
			end: new Date(Math.min(r.end.getTime(), end.getTime())),
		}))
		.filter((r) => r.end.getTime() > r.start.getTime())
		.sort((a, b) => a.start.getTime() - b.start.getTime());

	const merged: Array<{ start: Date; end: Date }> = [];
	for (const r of busyRanges) {
		const last = merged[merged.length - 1];
		if (last && r.start.getTime() <= last.end.getTime()) {
			last.end = new Date(Math.max(last.end.getTime(), r.end.getTime()));
		} else {
			merged.push({ ...r });
		}
	}

	// Derive free ranges as the complement within the window
	const free: Array<{ start: Date; end: Date }> = [];
	let cursor = start.getTime();
	for (const busy of merged) {
		if (busy.start.getTime() > cursor) {
			free.push({ start: new Date(cursor), end: new Date(busy.start.getTime()) });
		}
		cursor = Math.max(cursor, busy.end.getTime());
	}
	if (cursor < end.getTime()) {
		free.push({ start: new Date(cursor), end: new Date(end.getTime()) });
	}

	return {
		success: true,
		operation: 'getFreeBusy',
		method,
		rangeStart: start.toISOString(),
		rangeEnd: end.toISOString(),
		busy: merged.map((r) => ({ start: r.start.toISOString(), end: r.end.toISOString() })),
		free: free.map((r) => ({ start: r.start.toISOString(), end: r.end.toISOString() })),
		isBusy: merged.length > 0,
	};
}

// -----------------------------------------------------------------------------
// Dispatcher
// -----------------------------------------------------------------------------

export type SupportedOperation =
	| 'getEvents'
	| 'createEvent'
	| 'updateEvent'
	| 'deleteEvent'
	| 'getFreeBusy';

export async function runOperation(
	ctx: IExecuteFunctions,
	credentials: CalDavCredentials,
	operation: SupportedOperation,
	params: Record<string, unknown>,
	tzid: string,
): Promise<IDataObject> {
	switch (operation) {
		case 'getEvents':
			return opGetEvents(ctx, credentials, params);
		case 'createEvent':
			return opCreateEvent(ctx, credentials, params, tzid);
		case 'updateEvent':
			return opUpdateEvent(ctx, credentials, params, tzid);
		case 'deleteEvent':
			return opDeleteEvent(ctx, credentials, params);
		case 'getFreeBusy':
			return opGetFreeBusy(ctx, credentials, params);
		default:
			throw new Error(`Unsupported operation: ${operation}`);
	}
}
