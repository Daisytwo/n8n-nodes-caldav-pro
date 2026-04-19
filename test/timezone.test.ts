import {
	buildVTimezone,
	detectTimezoneInfo,
	formatDateOnly,
	formatLocalDateTime,
	formatUtcStamp,
	getOffsetMinutes,
} from '../nodes/CalDav/helpers/Timezone';

describe('Timezone – offset detection', () => {
	test('UTC is always zero', () => {
		expect(getOffsetMinutes('UTC', new Date('2026-01-15T00:00:00Z'))).toBe(0);
		expect(getOffsetMinutes('UTC', new Date('2026-07-15T00:00:00Z'))).toBe(0);
	});

	test('Europe/Berlin switches between +60 and +120', () => {
		const winter = getOffsetMinutes('Europe/Berlin', new Date('2026-01-15T12:00:00Z'));
		const summer = getOffsetMinutes('Europe/Berlin', new Date('2026-07-15T12:00:00Z'));
		expect(winter).toBe(60);
		expect(summer).toBe(120);
	});

	test('Asia/Tokyo has no DST', () => {
		const winter = getOffsetMinutes('Asia/Tokyo', new Date('2026-01-15T00:00:00Z'));
		const summer = getOffsetMinutes('Asia/Tokyo', new Date('2026-07-15T00:00:00Z'));
		expect(winter).toBe(540);
		expect(summer).toBe(540);
	});

	test('detectTimezoneInfo reports daylight only when different', () => {
		expect(detectTimezoneInfo('Asia/Tokyo').daylightOffsetMinutes).toBeNull();
		const berlin = detectTimezoneInfo('Europe/Berlin');
		expect(berlin.standardOffsetMinutes).toBe(60);
		expect(berlin.daylightOffsetMinutes).toBe(120);
	});
});

describe('Timezone – VTIMEZONE emission', () => {
	test('Europe/Berlin block has DAYLIGHT before STANDARD and correct offsets', () => {
		const lines = buildVTimezone('Europe/Berlin');
		const joined = lines.join('\n');
		expect(joined).toMatch(/BEGIN:VTIMEZONE/);
		expect(joined).toMatch(/TZID:Europe\/Berlin/);
		expect(joined).toMatch(/BEGIN:DAYLIGHT[\s\S]+TZOFFSETFROM:\+0100[\s\S]+TZOFFSETTO:\+0200[\s\S]+END:DAYLIGHT/);
		expect(joined).toMatch(/BEGIN:STANDARD[\s\S]+TZOFFSETFROM:\+0200[\s\S]+TZOFFSETTO:\+0100[\s\S]+END:STANDARD/);
	});

	test('UTC emits a trivial single-component block', () => {
		const lines = buildVTimezone('UTC');
		expect(lines).toContain('TZID:UTC');
		expect(lines).toContain('TZOFFSETFROM:+0000');
		expect(lines).toContain('TZOFFSETTO:+0000');
	});

	test('Non-DST zone (Asia/Tokyo) emits single STANDARD', () => {
		const lines = buildVTimezone('Asia/Tokyo');
		const joined = lines.join('\n');
		expect(joined).not.toMatch(/BEGIN:DAYLIGHT/);
		expect(joined).toMatch(/TZOFFSETFROM:\+0900/);
	});

	test('North American zone uses the 2SU/1SU rule', () => {
		const lines = buildVTimezone('America/New_York');
		const joined = lines.join('\n');
		expect(joined).toMatch(/BYMONTH=3;BYDAY=2SU/);
		expect(joined).toMatch(/BYMONTH=11;BYDAY=1SU/);
	});
});

describe('Timezone – date formatters', () => {
	test('formatLocalDateTime renders wall-clock in the target zone', () => {
		// 2026-04-14T10:00:00Z is 2026-04-14 12:00:00 in Berlin (DST)
		const d = new Date('2026-04-14T10:00:00Z');
		expect(formatLocalDateTime(d, 'Europe/Berlin')).toBe('20260414T120000');
		expect(formatLocalDateTime(d, 'UTC')).toBe('20260414T100000');
	});

	test('formatDateOnly truncates to YYYYMMDD', () => {
		const d = new Date('2026-04-14T22:00:00Z');
		// In Berlin that is the 15th
		expect(formatDateOnly(d, 'Europe/Berlin')).toBe('20260415');
		expect(formatDateOnly(d, 'UTC')).toBe('20260414');
	});

	test('formatUtcStamp renders Zulu timestamp', () => {
		const d = new Date('2026-04-14T10:00:00.123Z');
		expect(formatUtcStamp(d)).toBe('20260414T100000Z');
	});
});
