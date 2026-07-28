import type { INodeProperties } from 'n8n-workflow';

export const eventOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: {
				resource: ['event'],
			},
		},
		options: [
			{
				name: 'Create',
				value: 'create',
				description: 'Create a new calendar event',
				action: 'Create an event',
			},
			{
				name: 'Delete',
				value: 'delete',
				description: 'Delete a calendar event by its UID or URL',
				action: 'Delete an event',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Get a single calendar event by its UID or URL',
				action: 'Get an event',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'Get many events from a calendar within a time window',
				action: 'Get many events',
			},
			{
				name: 'Get Next',
				value: 'getNext',
				description: 'Get the next upcoming event(s) starting from now',
				action: 'Get the next event',
			},
			{
				name: 'Move',
				value: 'move',
				description: 'Move an event to a different calendar (keeps the same UID)',
				action: 'Move an event',
			},
			{
				name: 'Search',
				value: 'search',
				description: 'Search events by keyword in title, description, or location',
				action: 'Search events',
			},
			{
				name: 'Update',
				value: 'update',
				description: 'Update an existing calendar event',
				action: 'Update an event',
			},
		],
		default: 'create',
	},
];

const calendarParameter: INodeProperties = {
	displayName: 'Calendar Name or ID',
	name: 'calendar',
	type: 'options',
	typeOptions: {
		loadOptionsMethod: 'getCalendars',
	},
	required: true,
	default: '',
	description: 'The CalDAV calendar to operate on. Three options: (1) pick a specific calendar from the dropdown; (2) pick "🏠 Default Calendar (From Credentials)" to use the calendar configured in the CalDAV credential — works for any operation; (3) pick "⭐ All Calendars (Search Across)" to query every visible calendar at once — only valid for Get Many / Get Next / Search. For Move, this is the SOURCE calendar. The values are full calendar URLs. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	displayOptions: {
		show: {
			resource: ['event'],
		},
	},
};

export const eventFields: INodeProperties[] = [
	// ─────────── shared: Calendar ───────────
	calendarParameter,

	// ─────────── Event: Get / Delete / Update by UID ───────────
	{
		displayName: 'Event UID',
		name: 'uid',
		type: 'string',
		default: '',
		description:
			'The unique identifier of the event (the value of the iCalendar "UID" property). Returned by the Create operation as "uid". The event is located by querying the calendar for this UID. Either this or Event URL is required; Event URL is faster and more reliable when you have it.',
		displayOptions: {
			show: {
				resource: ['event'],
				operation: ['delete', 'get', 'move', 'update'],
			},
		},
	},
	{
		displayName: 'Event URL',
		name: 'eventUrl',
		type: 'string',
		default: '',
		placeholder: 'https://sync.example.com/calendars/user/uuid/abc123.ics',
		description: 'The exact URL of the event resource, as returned in the "URL" field by Get / Get Many / Get Next / Search. Prefer this when chaining from a read operation: it addresses the event directly and skips the UID lookup. Takes precedence over Event UID when both are given.',
		displayOptions: {
			show: {
				resource: ['event'],
				operation: ['delete', 'get', 'move', 'update'],
			},
		},
	},
	{
		displayName: 'Occurrence',
		name: 'recurrenceId',
		type: 'string',
		default: '',
		placeholder: '2026-04-13T08:00:00.000Z',
		description:
			'Act on one occurrence of a recurring event instead of the whole series. Pass the "recurrenceId" value exactly as a read operation returned it for that occurrence. Deleting cancels just that date; updating moves or changes just that one, leaving the rest of the series alone. Leave empty for a non-recurring event, or to act on a whole series together with "Entire Series".',
		displayOptions: {
			show: {
				resource: ['event'],
				operation: ['delete', 'update'],
			},
		},
	},
	{
		displayName: 'Entire Series',
		name: 'entireSeries',
		type: 'boolean',
		default: false,
		description:
			'Whether to act on every occurrence of a recurring event. All occurrences of a series share one UID and one resource, so deleting or updating by UID always hits the whole series — there is no way to change a single occurrence yet. When the target turns out to be recurring and this is off, the operation is refused rather than silently affecting every occurrence. Has no effect on non-recurring events.',
		displayOptions: {
			show: {
				resource: ['event'],
				operation: ['delete', 'update'],
			},
		},
	},
	{
		displayName: 'Target Calendar Name or ID',
		name: 'targetCalendar',
		type: 'options',
		typeOptions: {
			loadOptionsMethod: 'getCalendars',
		},
		required: true,
		default: '',
		description:
			'The destination calendar to move the event into. Pick a specific calendar — "All Calendars" is not valid here. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		displayOptions: {
			show: {
				resource: ['event'],
				operation: ['move'],
			},
		},
	},
	{
		displayName: 'Query',
		name: 'query',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'Alice',
		description:
			'Text to search for. Matched case-insensitively against the event title (SUMMARY), description, location, and UID. Examples: "Alice" finds every event mentioning Alice; "Zahnarzt" finds dentist appointments.',
		displayOptions: {
			show: {
				resource: ['event'],
				operation: ['search'],
			},
		},
	},
	{
		displayName: 'Lookahead Days',
		name: 'lookaheadDays',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 30,
		description:
			'How far into the future to look for the next event(s). 7 = next week, 30 = next month, 365 = next year. The window starts at the current time.',
		displayOptions: {
			show: {
				resource: ['event'],
				operation: ['getNext'],
			},
		},
	},

	// ─────────── Event: Create / Update fields ───────────
	{
		displayName: 'Summary',
		name: 'summary',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'Team meeting',
		description: 'The title of the calendar event, e.g. "Team meeting" or "Dentist appointment"',
		displayOptions: {
			show: {
				resource: ['event'],
				operation: ['create', 'update'],
			},
		},
	},
	{
		displayName: 'Start',
		name: 'start',
		type: 'dateTime',
		required: true,
		default: '={{ $now }}',
		description:
			'Event start time in ISO 8601 format with timezone offset, e.g. "2026-04-20T14:00:00+02:00". Use UTC ("Z") if timezone is unknown.',
		displayOptions: {
			show: {
				resource: ['event'],
				operation: ['create', 'update'],
			},
		},
	},
	{
		displayName: 'End',
		name: 'end',
		type: 'dateTime',
		required: true,
		default: "={{ $now.plus(1, 'hour') }}",
		description:
			'Event end time in ISO 8601 format with timezone offset, e.g. "2026-04-20T15:00:00+02:00". Must be after Start. For all-day events you can give the last day inclusively (same day as Start for a one-day event) — it is converted to the exclusive end iCalendar requires.',
		displayOptions: {
			show: {
				resource: ['event'],
				operation: ['create', 'update'],
			},
		},
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		description:
			'On Update these are applied as a patch: any field you do not add here keeps its current value on the server, and adding a field but leaving it empty clears it. You therefore do not need to restate the whole event to change one detail.',
		displayOptions: {
			show: {
				resource: ['event'],
				operation: ['create', 'update'],
			},
		},
		options: [
			{
				displayName: 'All Day',
				name: 'allDay',
				type: 'boolean',
				default: false,
				description:
					'Whether the event spans full days (no time component). If true, only the calendar date part of Start/End is used and the time and timezone are ignored. A one-day event needs Start and End on the same day. On Update, omit this field to keep the event as it is stored.',
			},
			{
				displayName: 'Attendees',
				name: 'attendees',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				description:
					'List of attendee email addresses to invite to the event. On Update this replaces the existing attendee list in full, so include everyone who should remain.',
				placeholder: 'Add Attendee',
				options: [
					{
						name: 'attendee',
						displayName: 'Attendee',
						values: [
							{
								displayName: 'Email',
								name: 'email',
								type: 'string',
								placeholder: 'alice@example.com',
								default: '',
								description: 'The attendee\'s email address',
							},
							{
								displayName: 'Name',
								name: 'name',
								type: 'string',
								default: '',
								description: 'Optional display name of the attendee',
							},
						],
					},
				],
			},
			{
				displayName: 'Description',
				name: 'description',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				description: 'Longer free-text description of the event (notes, agenda, links)',
			},
			{
				displayName: 'Location',
				name: 'location',
				type: 'string',
				default: '',
				placeholder: 'Berlin or https://meet.example.com/abc',
				description: 'Physical address or meeting URL for the event',
			},
			{
				displayName: 'Reminders',
				name: 'reminders',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				placeholder: 'Add Reminder',
				description:
					'Alarms that notify attendees before the event starts. Multiple reminders are allowed (e.g. 1 day + 15 minutes before). On Update this replaces the existing alarms in full.',
				options: [
					{
						name: 'reminder',
						displayName: 'Reminder',
						values: [
							{
								displayName: 'Minutes Before',
								name: 'minutesBefore',
								type: 'number',
								typeOptions: { minValue: 0 },
								default: 15,
								description:
									'How many minutes before the event start the reminder fires. Examples: 10 = 10min before, 60 = 1 hour before, 1440 = 1 day before.',
							},
							{
								displayName: 'Action',
								name: 'action',
								type: 'options',
								default: 'DISPLAY',
								description:
									'How the reminder is delivered. "Display" pops up a desktop/mobile notification (most common). "Email" sends an email.',
								options: [
									{ name: 'Display', value: 'DISPLAY' },
									{ name: 'Email', value: 'EMAIL' },
								],
							},
						],
					},
				],
			},
			{
				displayName: 'RRULE (Recurrence)',
				name: 'rrule',
				type: 'string',
				default: '',
				placeholder: 'FREQ=WEEKLY;BYDAY=MO;COUNT=10',
				description:
					'RFC 5545 recurrence rule without the "RRULE:" prefix. Examples: "FREQ=DAILY;COUNT=5", "FREQ=WEEKLY;BYDAY=MO,WE,FR", "FREQ=MONTHLY;BYMONTHDAY=15".',
			},
			{
				displayName: 'Timezone',
				name: 'timezone',
				type: 'string',
				default: '',
				placeholder: 'Europe/Berlin',
				description:
					'IANA timezone identifier to attach to Start/End via TZID. Leave empty to use UTC (Z suffix).',
			},
			{
				displayName: 'UID',
				name: 'uid',
				type: 'string',
				default: '',
				description:
					'Override the generated event UID. Leave empty for an auto-generated v4 UUID. Used only on Create.',
			},
		],
	},

	// ─────────── Event: Get All filters ───────────
	{
		displayName: 'Simplify',
		name: 'simplify',
		type: 'boolean',
		default: true,
		description:
			'Whether to return a simplified version of the response. When enabled the full iCalendar source ("raw") is omitted, which keeps the output readable and — for a recurring series, where every occurrence repeats the same source — much smaller. Turn this off if you need the original VCALENDAR text.',
		displayOptions: {
			show: {
				resource: ['event'],
				operation: ['get', 'getAll', 'getNext', 'search'],
			},
		},
	},
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: {
			show: {
				resource: ['event'],
				operation: ['getAll', 'getNext', 'search'],
			},
		},
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		default: 50,
		typeOptions: { minValue: 1 },
		description: 'Max number of results to return',
		displayOptions: {
			show: {
				resource: ['event'],
				operation: ['getAll', 'getNext', 'search'],
				returnAll: [false],
			},
		},
	},
	{
		displayName: 'Time Min',
		name: 'timeMin',
		type: 'dateTime',
		required: true,
		default: '={{ $now.startOf("day") }}',
		description:
			'Earliest event start time to return, in ISO 8601 format, e.g. "2026-04-20T00:00:00+02:00". Required by CalDAV servers for performance.',
		displayOptions: {
			show: {
				resource: ['event'],
				operation: ['getAll', 'search'],
			},
		},
	},
	{
		displayName: 'Time Max',
		name: 'timeMax',
		type: 'dateTime',
		required: true,
		default: '={{ $now.plus(7, "days").endOf("day") }}',
		description:
			'Latest event start time to return, in ISO 8601 format, e.g. "2026-04-27T23:59:59+02:00". Must be after Time Min.',
		displayOptions: {
			show: {
				resource: ['event'],
				operation: ['getAll', 'search'],
			},
		},
	},
];
