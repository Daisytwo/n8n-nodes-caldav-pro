/**
 * Turn a failed CalDAV request into an editor-safe diagnostic.
 *
 * A failure during calendar discovery carries the things that must not reach
 * the editor: the credential's server URL (often a per-user token path), the
 * username, and whatever the server echoed back in its response body. n8n
 * renders a load-options error verbatim in the dropdown, so nothing is
 * forwarded from the original error. Only an allow-listed HTTP status or
 * connection code crosses the boundary; everything else collapses into the
 * generic case below.
 */

/** Node/OpenSSL codes that say something actionable and contain no user data. */
const CONNECTION_CODES = new Set([
	'ECONNREFUSED',
	'ECONNRESET',
	'ECONNABORTED',
	'ETIMEDOUT',
	'ENOTFOUND',
	'EAI_AGAIN',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'CERT_HAS_EXPIRED',
	'DEPTH_ZERO_SELF_SIGNED_CERT',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
	'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Where the status lives differs per layer: n8n wrapper, fetch response, raw socket error. */
const STATUS_KEYS = ['httpCode', 'statusCode', 'status'];

/** n8n and undici both nest the real cause several levels down. */
const NESTED_KEYS = ['cause', 'errorResponse', 'response', 'reason'];

/** Bound the walk: a wrapped error graph can be deep, and none of it is trusted. */
const MAX_VISITED = 20;

export interface CalendarDiagnostic {
	/** Shown as the dropdown error. */
	message: string;
	/** Shown underneath it as guidance. */
	description: string;
	/** Status or code only — safe to write to the debug log. */
	cause: string;
}

export function calendarDiagnostic(error: unknown): CalendarDiagnostic {
	const queue: unknown[] = [error];
	const seen = new Set<unknown>();
	let status: string | undefined;
	let code: string | undefined;

	while (queue.length && seen.size < MAX_VISITED) {
		const current = queue.shift();
		if (!current || typeof current !== 'object' || seen.has(current)) continue;
		seen.add(current);
		const item = current as Record<string, unknown>;

		for (const key of [...STATUS_KEYS, 'code']) {
			const value = item[key];
			if (typeof value === 'string' && CONNECTION_CODES.has(value)) code ??= value;
			if (status || key === 'code') continue;
			if (typeof value !== 'string' && typeof value !== 'number') continue;
			if (/^[45]\d{2}$/.test(String(value))) status = String(value);
		}

		for (const key of NESTED_KEYS) queue.push(item[key]);
	}

	if (status === '401') {
		return {
			message: 'CalDAV credentials were rejected (HTTP 401).',
			description:
				'Check the CalDAV API username and password. Your provider may require an app password; Infomaniak uses a short username, not an email address.',
			cause: 'HTTP 401',
		};
	}
	if (status === '403') {
		return {
			message: 'CalDAV access was denied (HTTP 403).',
			description:
				'Check the CalDAV API credential and account permissions. This response does not prove that authentication succeeded or that a calendar is read-only.',
			cause: 'HTTP 403',
		};
	}
	if (status) {
		return {
			message: `Calendar discovery failed (HTTP ${status}).`,
			description:
				'Check the CalDAV API Server URL and provider availability, then reload the Calendar dropdown.',
			cause: `HTTP ${status}`,
		};
	}
	if (code) {
		return {
			message: `CalDAV connection failed (${code}).`,
			description:
				'Check the Server URL, DNS, network access and TLS certificate from the n8n host, then retry.',
			cause: code,
		};
	}
	return {
		message: 'Calendar discovery failed.',
		description:
			'Check the CalDAV API configuration and server response. No safe HTTP status or connection code was available; raw details are hidden to protect credentials and URLs.',
		cause: 'Unclassified discovery failure',
	};
}
