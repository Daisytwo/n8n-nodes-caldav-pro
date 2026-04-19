/**
 * Higher-level operation tests. We don't call over the network; instead we
 * stub `helpers.httpRequestWithAuthentication` so the CalDAV client operates
 * on recorded responses.
 */

import { runOperation } from '../nodes/CalDav/helpers/Operations';

type HttpCall = {
	method: string;
	url: string;
	headers?: Record<string, string>;
	body?: string;
};

function makeCtx(responder: (call: HttpCall) => { statusCode: number; headers?: Record<string, string>; body: string }) {
	const calls: HttpCall[] = [];
	const ctx = {
		helpers: {
			httpRequestWithAuthentication: async function (
				_credentialName: string,
				options: {
					method?: string;
					url?: string;
					headers?: Record<string, string>;
					body?: string;
				},
			) {
				const call: HttpCall = {
					method: options.method ?? 'GET',
					url: options.url ?? '',
					headers: options.headers,
					body: options.body,
				};
				calls.push(call);
				return responder(call);
			},
		},
	} as unknown as Parameters<typeof runOperation>[0];
	return { ctx, calls };
}

const credentials = {
	serverUrl: 'https://caldav.example.com/calendars/me/cal/',
	username: 'u',
	password: 'p',
};

describe('Operations – getEvents', () => {
	test('returns empty array (not error) when server has no events', async () => {
		const { ctx } = makeCtx(() => ({
			statusCode: 207,
			headers: { 'content-type': 'application/xml' },
			body: '<?xml version="1.0"?><multistatus xmlns="DAV:"></multistatus>',
		}));
		const result = await runOperation(
			ctx,
			credentials,
			'getEvents',
			{ date: '2026-04-14' },
			'UTC',
		);
		expect(result.success).toBe(true);
		expect(result.count).toBe(0);
		expect(result.events).toEqual([]);
	});

	test('parses one event correctly', async () => {
		const ical = [
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'BEGIN:VEVENT',
			'UID:e1',
			'SUMMARY:Lunch',
			'DTSTART;TZID=Europe/Berlin:20260414T120000',
			'DTEND;TZID=Europe/Berlin:20260414T130000',
			'END:VEVENT',
			'END:VCALENDAR',
		].join('\r\n');
		const body = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/calendars/me/cal/e1.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"etag-1"</d:getetag>
        <c:calendar-data><![CDATA[${ical}]]></c:calendar-data>
      </d:prop>
    </d:propstat>
  </d:response>
</d:multistatus>`;
		const { ctx } = makeCtx(() => ({
			statusCode: 207,
			headers: { 'content-type': 'application/xml' },
			body,
		}));
		const result = (await runOperation(
			ctx,
			credentials,
			'getEvents',
			{ date: '2026-04-14' },
			'Europe/Berlin',
		)) as any;
		expect(result.count).toBe(1);
		expect(result.events[0].summary).toBe('Lunch');
		// 12:00 Berlin DST = 10:00Z
		expect(result.events[0].start).toBe('2026-04-14T10:00:00.000Z');
	});
});

describe('Operations – createEvent', () => {
	test('PUTs a VCALENDAR with TZID, generates UID', async () => {
		const { ctx, calls } = makeCtx((call) => {
			if (call.method === 'PUT') {
				return { statusCode: 201, headers: { etag: '"new-etag"' }, body: '' };
			}
			return { statusCode: 200, body: '' };
		});
		const result = (await runOperation(
			ctx,
			credentials,
			'createEvent',
			{
				Event_Title: 'Team sync',
				Start_Date_and_Time: '2026-04-14T12:00:00+02:00',
				End_Date_and_Time: '2026-04-14T13:00:00+02:00',
				Location: 'Zoom',
				Reminder: 15,
			},
			'Europe/Berlin',
		)) as any;

		expect(result.success).toBe(true);
		const put = calls.find((c) => c.method === 'PUT')!;
		expect(put.body).toMatch(/DTSTART;TZID=Europe\/Berlin:20260414T120000/);
		expect(put.body).toMatch(/SUMMARY:Team sync/);
		expect(put.body).toMatch(/LOCATION:Zoom/);
		expect(put.body).toMatch(/TRIGGER:-PT15M/);
		expect(put.body).not.toMatch(/DTSTART:\d{8}T\d{6}Z/);
		expect(result.uid).toMatch(/.+@n8n-caldav/);
	});

	test('Recurring event writes RRULE', async () => {
		const { ctx, calls } = makeCtx(() => ({ statusCode: 201, body: '' }));
		await runOperation(
			ctx,
			credentials,
			'createEvent',
			{
				Event_Title: 'Standup',
				Start_Date_and_Time: '2026-04-14T09:00:00+02:00',
				End_Date_and_Time: '2026-04-14T09:15:00+02:00',
				Recurring_Event: true,
				Recurrence_Frequency: 'WEEKLY',
				Recurrence_Interval: 1,
				Recurrence_By_Day: 'MO,TU,WE,TH,FR',
				Recurrence_End_Type: 'count',
				Recurrence_Count: 10,
			},
			'Europe/Berlin',
		);
		const put = calls.find((c) => c.method === 'PUT')!;
		expect(put.body).toMatch(/RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=10/);
	});
});

describe('Operations – error handling', () => {
	test('Failing PUT surfaces an Error (caller decides continueOnFail)', async () => {
		const { ctx } = makeCtx(() => ({ statusCode: 500, body: 'boom' }));
		await expect(
			runOperation(
				ctx,
				credentials,
				'createEvent',
				{
					eventTitle: 't',
					startDateAndTime: '2026-04-14T10:00:00Z',
					endDateAndTime: '2026-04-14T11:00:00Z',
				},
				'UTC',
			),
		).rejects.toThrow(/HTTP 500/);
	});

	test('deleteEvent on 404 returns deleted=false (no throw)', async () => {
		const { ctx } = makeCtx(() => ({ statusCode: 404, body: 'Not Found' }));
		const result = (await runOperation(
			ctx,
			credentials,
			'deleteEvent',
			{ UID: 'abc' },
			'UTC',
		)) as any;
		expect(result.success).toBe(true);
		expect(result.deleted).toBe(false);
	});

	test('bad UID (empty) raises', async () => {
		const { ctx } = makeCtx(() => ({ statusCode: 200, body: '' }));
		await expect(
			runOperation(ctx, credentials, 'deleteEvent', { UID: '' }, 'UTC'),
		).rejects.toThrow(/UID/);
	});
});

describe('Operations – getFreeBusy', () => {
	test('falls back to calendar-query when free-busy returns nothing', async () => {
		const ical = [
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'BEGIN:VEVENT',
			'UID:busy-1',
			'SUMMARY:Busy',
			'DTSTART:20260414T100000Z',
			'DTEND:20260414T110000Z',
			'END:VEVENT',
			'END:VCALENDAR',
		].join('\r\n');
		const multistatus = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response><d:href>/x.ics</d:href><d:propstat><d:prop>
    <d:getetag>"e"</d:getetag>
    <c:calendar-data><![CDATA[${ical}]]></c:calendar-data>
  </d:prop></d:propstat></d:response>
</d:multistatus>`;

		let callCount = 0;
		const { ctx } = makeCtx(() => {
			callCount++;
			// First call: free-busy-query returns 200 but no FREEBUSY lines -> fallback
			// Second call: calendar-query returns our multistatus
			if (callCount === 1) return { statusCode: 200, body: '<ok/>' };
			return { statusCode: 207, headers: { 'content-type': 'application/xml' }, body: multistatus };
		});

		const result = (await runOperation(
			ctx,
			credentials,
			'getFreeBusy',
			{
				Start_Date: '2026-04-14T00:00:00Z',
				End_Date: '2026-04-15T00:00:00Z',
			},
			'UTC',
		)) as any;
		expect(result.success).toBe(true);
		expect(result.isBusy).toBe(true);
		expect(result.busy).toEqual([
			{ start: '2026-04-14T10:00:00.000Z', end: '2026-04-14T11:00:00.000Z' },
		]);
		// Free ranges cover the rest of the day
		expect(result.free.length).toBe(2);
	});
});
