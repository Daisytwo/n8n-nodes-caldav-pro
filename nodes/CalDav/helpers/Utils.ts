/**
 * Generic helpers used by both the standard and the AI tool node:
 *   - input normalisation (camelCase / snake_case / UPPER_CASE)
 *   - iCal text escaping
 *   - UID sanitisation
 *   - URL path traversal guard
 *   - structured error payloads
 */

// -----------------------------------------------------------------------------
// Parameter normalisation
// -----------------------------------------------------------------------------

/**
 * Convert a parameter name to a canonical camelCase form so that a field
 * can be supplied as `recurrenceCount`, `Recurrence_Count`, `RECURRENCE_COUNT`,
 * `recurrence-count`, etc. interchangeably.
 */
export function toCamelKey(input: string): string {
	if (!input) return input;
	// Split on explicit separators and camelCase / ALLCAPS transitions.
	const tokens = input
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.split(/[^a-zA-Z0-9]+/)
		.filter(Boolean);
	if (tokens.length === 0) return '';
	return tokens
		.map((part, idx) => {
			const lower = part.toLowerCase();
			if (idx === 0) return lower;
			return lower.charAt(0).toUpperCase() + lower.slice(1);
		})
		.join('');
}

/**
 * Normalise an object's keys to camelCase. Keeps the first occurrence if two
 * variants map to the same canonical key.
 */
export function normalizeParams<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
	if (!input || typeof input !== 'object') return {};
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const canonical = toCamelKey(key);
		if (canonical && !(canonical in out)) {
			out[canonical] = value;
		}
	}
	return out;
}

/**
 * Read a parameter from an object using the canonical camelCase name.
 * Accepts aliases (camel / snake / UPPER / kebab).
 */
export function pickParam<T = unknown>(
	input: Record<string, unknown>,
	canonical: string,
	fallback?: T,
): T | undefined {
	if (!input) return fallback;
	if (canonical in input && input[canonical] !== undefined && input[canonical] !== '') {
		return input[canonical] as T;
	}
	const target = canonical.toLowerCase();
	for (const [key, value] of Object.entries(input)) {
		if (toCamelKey(key).toLowerCase() === target && value !== undefined && value !== '') {
			return value as T;
		}
	}
	return fallback;
}

// -----------------------------------------------------------------------------
// Validation / security
// -----------------------------------------------------------------------------

/**
 * Sanitise a user-supplied UID to a safe subset. Allowed: word chars,
 * hyphen, dot and @. Everything else is replaced by an underscore.
 */
export function sanitizeUid(uid: string): string {
	if (!uid || typeof uid !== 'string') {
		throw new Error('UID is required and must be a non-empty string');
	}
	const trimmed = uid.trim();
	if (!trimmed) throw new Error('UID is required and must be a non-empty string');
	return trimmed.replace(/[^\w\-.@]/g, '_');
}

/**
 * Refuse obviously malicious path segments: traversal (`..`) or double slashes.
 * The CalDAV server URL itself is trusted (provided by the admin); this guard
 * is only concerned with the file portion the node appends to it.
 */
export function assertSafePathSegment(segment: string): void {
	if (!segment) throw new Error('Calendar resource path must not be empty');
	if (segment.includes('..')) {
		throw new Error('Calendar resource path must not contain ".." (path traversal)');
	}
	if (segment.includes('//')) {
		throw new Error('Calendar resource path must not contain "//"');
	}
	// Control characters break requests and can smuggle headers
	if (/[\x00-\x1f\x7f]/.test(segment)) {
		throw new Error('Calendar resource path contains control characters');
	}
}

/**
 * Ensure a string value is present and non-empty. Returns the trimmed value.
 */
export function requireString(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new Error(`Parameter "${field}" is required and must be a non-empty string`);
	}
	return value.trim();
}

// -----------------------------------------------------------------------------
// iCal text escaping (RFC 5545 §3.3.11)
// -----------------------------------------------------------------------------

/**
 * Escape text for use inside TEXT-typed iCal properties
 * (SUMMARY, DESCRIPTION, LOCATION, ...). Also strips control characters.
 */
export function escapeICalText(value: string | undefined | null): string {
	if (value === undefined || value === null) return '';
	return String(value)
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '') // strip controls (keep \n,\r,\t)
		.replace(/\\/g, '\\\\')
		.replace(/;/g, '\\;')
		.replace(/,/g, '\\,')
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.replace(/\n/g, '\\n');
}

/**
 * Line folding per RFC 5545 §3.1: lines longer than 75 octets are split and
 * continuation lines start with a single space. We split at 73 chars to stay
 * well below the octet limit for multi-byte UTF-8.
 */
export function foldICalLine(line: string): string {
	if (line.length <= 75) return line;
	const parts: string[] = [];
	let first = true;
	let rest = line;
	while (rest.length > 0) {
		const limit = first ? 75 : 74;
		parts.push((first ? '' : ' ') + rest.slice(0, limit));
		rest = rest.slice(limit);
		first = false;
	}
	return parts.join('\r\n');
}

export function joinICal(lines: string[]): string {
	return lines.map(foldICalLine).join('\r\n') + '\r\n';
}

// -----------------------------------------------------------------------------
// Error helpers
// -----------------------------------------------------------------------------

export interface StructuredError {
	success: false;
	error: string;
	operation: string;
	timestamp: string;
	[k: string]: unknown;
}

export function buildErrorPayload(
	error: unknown,
	operation: string,
	extra?: Record<string, unknown>,
): StructuredError {
	const message =
		error instanceof Error
			? error.message
			: typeof error === 'string'
				? error
				: 'Unknown error';
	return {
		success: false,
		error: message,
		operation,
		timestamp: new Date().toISOString(),
		...(extra ?? {}),
	};
}
