/**
 * Node re-reads process.env.TZ on change (>= v16), so we can exercise the same
 * code under different host timezones inside one process. That matters here:
 * the bugs these tests guard against only appear when the n8n host's timezone
 * differs from the event's timezone, which is the normal case in Docker (UTC).
 */
export function withTZ<T>(tz: string, fn: () => T): T {
	const previous = process.env.TZ;
	process.env.TZ = tz;
	try {
		return fn();
	} finally {
		if (previous === undefined) delete process.env.TZ;
		else process.env.TZ = previous;
	}
}

/** Host timezones we assert invariance across: UTC, ahead of UTC, behind UTC. */
export const HOST_ZONES = ['UTC', 'Europe/Berlin', 'America/New_York', 'Asia/Tokyo'];

/**
 * The VEVENT's own properties, excluding those of nested components.
 *
 * Scoping matters: a VALARM carries its own DESCRIPTION, so a naive search of
 * the whole object would report the alarm's text as the event's.
 */
export function veventLines(ics: string): string[] {
	const out: string[] = [];
	let inside = false;
	let depth = 0;
	for (const l of unfold(ics)) {
		if (l === 'BEGIN:VEVENT') {
			inside = true;
			continue;
		}
		if (l === 'END:VEVENT') {
			inside = false;
			continue;
		}
		if (!inside) continue;
		if (l.startsWith('BEGIN:')) depth++;
		else if (l.startsWith('END:')) depth--;
		else if (depth === 0) out.push(l);
	}
	return out;
}

const matches = (l: string, prop: string) => l.startsWith(`${prop}:`) || l.startsWith(`${prop};`);

/** Pull a single unfolded content line out of the VEVENT. */
export function line(ics: string, prop: string): string | undefined {
	return veventLines(ics).find((l) => matches(l, prop));
}

export function lines(ics: string, prop: string): string[] {
	return veventLines(ics).filter((l) => matches(l, prop));
}

/** Reverse RFC 5545 line folding so assertions can target logical lines. */
export function unfold(ics: string): string[] {
	const out: string[] = [];
	for (const raw of ics.split('\r\n')) {
		if ((raw.startsWith(' ') || raw.startsWith('\t')) && out.length) {
			out[out.length - 1] += raw.slice(1);
		} else {
			out.push(raw);
		}
	}
	return out;
}
