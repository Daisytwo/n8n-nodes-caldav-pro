/**
 * Normalise the raw tool input produced by an AI Agent into the flat,
 * canonical shape expected by `runOperation`.
 *
 * Agents built on different LLM providers (OpenAI, Anthropic, Mistral,
 * Gemini, Groq, …) serialise the schema differently, and many of them
 * routinely:
 *   - wrap the call in `{ arguments: {...} }` / `{ input: {...} }`,
 *   - nest event fields under `event`, `eventDetails`, `details`,
 *   - use natural aliases (`summary`, `title`, `start`, `end`) instead of
 *     the canonical `eventTitle`, `startDateAndTime`, `endDateAndTime`,
 *   - pass the whole thing as a JSON string.
 *
 * This helper makes the tool robust against all of these variations so
 * the surrounding agent loop does not have to.
 */

import { toCamelKey } from './Utils';

// Top-level wrappers the Agent may place the real payload inside.
const WRAPPER_KEYS = ['arguments', 'args', 'input', 'data', 'payload', 'parameters'];

// Nested objects whose properties should be flattened onto the top level.
// Top-level fields always win over nested ones (so a user-provided
// `eventTitle` beats `event.summary`).
const NESTED_CONTAINER_KEYS = [
	'event',
	'eventdetails',
	'details',
	'body',
	'fields',
	'parameters',
	'params',
	'args',
	'arguments',
	'timerange',
	'range',
	'period',
	'when',
	'recurrence',
	'repeat',
	'reminder',
	'alarm',
];

/**
 * Alias map: any of the keys on the right-hand side should be treated as
 * the canonical camelCase key on the left-hand side. Keys are compared
 * after running through `toCamelKey` so snake_case / kebab-case variants
 * are also matched.
 */
const ALIASES: Record<string, string[]> = {
	eventTitle: ['summary', 'title', 'name', 'subject'],
	startDateAndTime: [
		'start',
		'startTime',
		'startDateTime',
		'startsAt',
		'from',
		'begin',
		'beginTime',
		'dtstart',
	],
	endDateAndTime: [
		'end',
		'endTime',
		'endDateTime',
		'endsAt',
		'to',
		'finish',
		'finishTime',
		'dtend',
	],
	allDayEvent: ['allDay', 'isAllDay', 'wholeDay'],
	description: ['notes', 'body', 'details'],
	location: ['place', 'where', 'venue'],
	reminder: ['reminderMinutes', 'reminderMinutesBefore', 'alarm', 'alarmMinutes'],
	recurringEvent: ['recurring', 'repeat', 'isRecurring', 'repeats'],
	recurrenceFrequency: ['frequency', 'freq', 'repeatFrequency'],
	recurrenceInterval: ['interval', 'repeatInterval'],
	recurrenceEndType: ['endType', 'recurrenceEnd'],
	recurrenceCount: ['count', 'repeatCount', 'occurrences'],
	recurrenceUntil: ['until', 'repeatUntil', 'endDate'],
	recurrenceByDay: ['byDay', 'byday', 'days', 'weekdays'],
	uid: ['id', 'eventId', 'eventUid'],
	date: ['day', 'on'],
	startDate: ['rangeStart', 'fromDate'],
	endDate: ['rangeEnd', 'toDate'],
	operation: ['action', 'tool', 'type', 'method', 'command'],
};

/**
 * Build a reverse lookup keyed by the canonicalised alias name, e.g.
 * "summary" -> "eventTitle". Canonical keys also map to themselves so a
 * correctly-spelled field is preserved.
 */
function buildReverseAliasMap(): Map<string, string> {
	const out = new Map<string, string>();
	for (const [canonical, aliases] of Object.entries(ALIASES)) {
		out.set(toCamelKey(canonical), canonical);
		for (const alias of aliases) {
			out.set(toCamelKey(alias), canonical);
		}
	}
	return out;
}

const REVERSE_ALIAS = buildReverseAliasMap();

/**
 * Apply the alias map to a flat object: unknown keys are preserved as-is,
 * recognised aliases are rewritten to their canonical camelCase name.
 * If both alias and canonical appear in the same object, the canonical
 * value wins.
 */
function applyAliases(input: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	// Pass 1: copy recognised fields, preferring canonical keys.
	for (const [rawKey, value] of Object.entries(input)) {
		if (value === undefined || value === null || value === '') continue;
		const canonicalised = toCamelKey(rawKey);
		const mapped = REVERSE_ALIAS.get(canonicalised) ?? canonicalised;
		// If the target is already populated from the canonical key, skip.
		if (mapped in out && canonicalised !== mapped) continue;
		out[mapped] = value;
	}
	return out;
}

/**
 * Flatten nested container objects onto the top level. Top-level fields
 * win over nested ones.
 */
function flattenNested(input: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const deferred: Record<string, unknown> = {};

	for (const [rawKey, value] of Object.entries(input)) {
		const canonicalised = toCamelKey(rawKey).toLowerCase();
		if (
			value &&
			typeof value === 'object' &&
			!Array.isArray(value) &&
			NESTED_CONTAINER_KEYS.includes(canonicalised)
		) {
			// Merge each field of the nested object into `deferred`; top-level
			// keys (collected below) will overwrite any conflicts.
			for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
				if (nestedValue === undefined || nestedValue === null || nestedValue === '') continue;
				if (!(nestedKey in deferred)) {
					deferred[nestedKey] = nestedValue;
				}
			}
		} else {
			out[rawKey] = value;
		}
	}

	// Top-level fields take precedence over nested ones.
	return { ...deferred, ...out };
}

/**
 * Unwrap any well-known top-level wrapper (e.g. `{ arguments: {...} }`).
 * If none is found the input is returned unchanged.
 */
function unwrap(input: Record<string, unknown>): Record<string, unknown> {
	for (const key of WRAPPER_KEYS) {
		const v = input[key];
		if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(input).length === 1) {
			return v as Record<string, unknown>;
		}
	}
	return input;
}

/**
 * Normalise the raw tool input into a flat canonical shape. Accepts:
 *   - plain objects
 *   - objects wrapped in `{ arguments: {...} }` / `{ input: {...} }` / ...
 *   - objects that nest event data under `event`, `eventDetails`, ...
 *   - aliases such as `summary`, `title`, `start`, `end`, `allDay`, ...
 *   - JSON strings (will be parsed)
 */
export function normalizeAgentInput(raw: unknown): Record<string, unknown> {
	if (raw === undefined || raw === null) return {};

	let working: Record<string, unknown>;

	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (!trimmed) return {};
		try {
			const parsed = JSON.parse(trimmed);
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
			working = parsed as Record<string, unknown>;
		} catch {
			// Not JSON — treat the whole string as the event title, which is
			// the most common shape when an agent hands over a bare string.
			return { eventTitle: trimmed };
		}
	} else if (typeof raw === 'object' && !Array.isArray(raw)) {
		working = raw as Record<string, unknown>;
	} else {
		return {};
	}

	working = unwrap(working);
	working = flattenNested(working);
	working = applyAliases(working);

	return working;
}

/**
 * Extract the operation from a (possibly pre-normalised) input, falling
 * through several common field names and trimming whitespace. Returns
 * undefined if none is present — the caller decides the default.
 */
export function extractOperation(input: Record<string, unknown>): string | undefined {
	const candidates = ['operation', 'action', 'tool', 'type', 'method', 'command'];
	for (const key of candidates) {
		const v = input[key];
		if (typeof v === 'string' && v.trim() !== '') return v.trim();
	}
	return undefined;
}
