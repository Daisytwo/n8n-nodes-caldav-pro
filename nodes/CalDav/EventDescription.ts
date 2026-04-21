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
				description: 'Delete a calendar event by its UID',
				action: 'Delete an event',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Get a single calendar event by its UID',
				action: 'Get an event',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'Get many events from a calendar within a time window',
				action: 'Get many events',
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
	description: 'The CalDAV calendar to operate on. Pick from the dropdown — the values are the full calendar URLs discovered from the server. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code-examples/expressions/">expression</a>. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
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
		required: true,
		default: '',
		description:
			'The unique identifier of the event (the value of the iCalendar "UID" property). Returned by the Create operation as "uid".',
		displayOptions: {
			show: {
				resource: ['event'],
				operation: ['get', 'delete', 'update'],
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
			'Event end time in ISO 8601 format with timezone offset, e.g. "2026-04-20T15:00:00+02:00". Must be after Start.',
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
					'Whether the event spans full days (no time component). If true, Start/End are interpreted as dates only.',
			},
			{
				displayName: 'Attendees',
				name: 'attendees',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				description: 'List of attendee email addresses to invite to the event',
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
					'Alarms that notify attendees before the event starts. Multiple reminders are allowed (e.g. 1 day + 15 minutes before).',
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
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: {
			show: {
				resource: ['event'],
				operation: ['getAll'],
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
				operation: ['getAll'],
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
				operation: ['getAll'],
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
				operation: ['getAll'],
			},
		},
	},
];
