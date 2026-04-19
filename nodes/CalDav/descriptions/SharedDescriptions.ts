/**
 * Shared property definitions used by both the standard node and the AI
 * tool node. The AI tool node deliberately uses `type: 'string'` for every
 * enum-like field (with allowed values spelled out in the description) so
 * that `$fromAI()` can supply free-form values without tripping n8n's
 * options validation.
 */

import type { INodeProperties } from 'n8n-workflow';

export const OPERATION_CHOICES = [
	{ name: 'Get Events', value: 'getEvents', action: 'Get events' },
	{ name: 'Create Event', value: 'createEvent', action: 'Create an event' },
	{ name: 'Update Event', value: 'updateEvent', action: 'Update an event' },
	{ name: 'Delete Event', value: 'deleteEvent', action: 'Delete an event' },
	{ name: 'Get Free/Busy', value: 'getFreeBusy', action: 'Get free/busy status' },
];

export const TOOL_OPERATION_DESCRIPTIONS: Record<string, string> = {
	getEvents:
		'Get calendar events for a specific date or date range. Returns empty array if no events found.',
	createEvent:
		'Create a new calendar event. For recurring events set Recurring_Event to true and provide recurrence parameters.',
	updateEvent: 'Update an existing calendar event by UID.',
	deleteEvent: 'Delete a calendar event by UID.',
	getFreeBusy: 'Check if a time slot is free or busy.',
};

// Condition helpers
const show = (operation: string[]) => ({ show: { operation } });
const showIf = (operation: string[], extra: Record<string, unknown[]>) => ({
	show: { operation, ...extra },
});

export interface BuildOptions {
	asTool: boolean;
}

/**
 * Build the full property set. The AI tool variant swaps `options` selects
 * for free-form strings (with the allowed values listed in the description)
 * so AI-generated values never fail n8n's enum validation.
 */
export function buildCalDavProperties(opts: BuildOptions): INodeProperties[] {
	const asTool = opts.asTool;

	const operationProperty: INodeProperties = asTool
		? {
				displayName: 'Operation',
				name: 'operation',
				type: 'string',
				default: 'getEvents',
			}
		: {
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: OPERATION_CHOICES,
				default: 'getEvents',
			};

	const dropdownOrString = (
		displayName: string,
		name: string,
		defaultValue: string,
		values: Array<{ name: string; value: string }>,
		displayOptions: INodeProperties['displayOptions'],
		description: string,
	): INodeProperties => {
		if (asTool) {
			const allowed = values.map((v) => v.value).join(', ');
			return {
				displayName,
				name,
				type: 'string',
				default: defaultValue,
				displayOptions,
				description: `${description} Allowed values: ${allowed}`,
			};
		}
		return {
			displayName,
			name,
			type: 'options',
			options: values,
			default: defaultValue,
			displayOptions,
			description,
		};
	};

	const properties: INodeProperties[] = [
		operationProperty,

		// ---------------------------------------------------------------------
		// Get Events
		// ---------------------------------------------------------------------
		{
			displayName: 'Date',
			name: 'date',
			type: 'string',
			default: '',
			placeholder: '2026-04-14',
			displayOptions: show(['getEvents']),
			description:
				'Single day to query in YYYY-MM-DD. Leave empty to use Start_Date + End_Date. If both are empty, the current UTC day is used.',
		},
		{
			displayName: 'Start Date',
			name: 'startDate',
			type: 'string',
			default: '',
			placeholder: '2026-04-14 or 2026-04-14T00:00:00+02:00',
			displayOptions: show(['getEvents', 'getFreeBusy']),
			description: 'Range start. Takes precedence over "Date" when both are provided.',
		},
		{
			displayName: 'End Date',
			name: 'endDate',
			type: 'string',
			default: '',
			placeholder: '2026-04-21 or 2026-04-21T23:59:59+02:00',
			displayOptions: show(['getEvents', 'getFreeBusy']),
			description: 'Range end. Required when Start Date is provided.',
		},

		// ---------------------------------------------------------------------
		// Create / Update Event — shared fields
		// ---------------------------------------------------------------------
		{
			displayName: 'UID',
			name: 'uid',
			type: 'string',
			default: '',
			required: true,
			displayOptions: show(['updateEvent', 'deleteEvent']),
			description: 'UID of the event to modify',
		},
		{
			displayName: 'UID (Optional)',
			name: 'uid',
			type: 'string',
			default: '',
			displayOptions: show(['createEvent']),
			description:
				'Custom UID. If empty a UUID is generated. Characters outside [A-Za-z0-9._-@] are replaced with _.',
		},
		{
			displayName: 'Event Title',
			name: 'eventTitle',
			type: 'string',
			default: '',
			displayOptions: show(['createEvent', 'updateEvent']),
			description: 'Summary / title of the event. Required for Create, optional for Update.',
		},
		{
			displayName: 'Start Date and Time',
			name: 'startDateAndTime',
			type: 'string',
			default: '',
			placeholder: '2026-04-14T12:00:00+02:00',
			displayOptions: show(['createEvent', 'updateEvent']),
			description:
				'ISO-8601 datetime with timezone offset, e.g. 2026-04-14T12:00:00+02:00. For all-day events, YYYY-MM-DD is accepted.',
		},
		{
			displayName: 'End Date and Time',
			name: 'endDateAndTime',
			type: 'string',
			default: '',
			placeholder: '2026-04-14T13:00:00+02:00',
			displayOptions: show(['createEvent', 'updateEvent']),
			description: 'Defaults to Start + 1 hour when empty',
		},
		{
			displayName: 'Location',
			name: 'location',
			type: 'string',
			default: '',
			displayOptions: show(['createEvent', 'updateEvent']),
			description: 'Location of the event',
		},
		{
			displayName: 'Description',
			name: 'description',
			type: 'string',
			typeOptions: { rows: 3 },
			default: '',
			displayOptions: show(['createEvent', 'updateEvent']),
			description: 'Free-form description / notes',
		},
		{
			displayName: 'All Day Event',
			name: 'allDayEvent',
			type: 'boolean',
			default: false,
			displayOptions: show(['createEvent', 'updateEvent']),
			description: 'Whether the event should be stored as a DATE-only all-day event',
		},
		{
			displayName: 'Reminder (Minutes Before Start)',
			name: 'reminder',
			type: 'number',
			typeOptions: { minValue: 0 },
			default: 0,
			displayOptions: show(['createEvent', 'updateEvent']),
			description:
				'Minutes before start to trigger a VALARM. 0 means no reminder. Generates a DISPLAY VALARM block.',
		},

		// ---------------------------------------------------------------------
		// Recurrence
		// ---------------------------------------------------------------------
		{
			displayName: 'Recurring Event',
			name: 'recurringEvent',
			type: 'boolean',
			default: false,
			displayOptions: show(['createEvent', 'updateEvent']),
			description: 'Whether the event should repeat',
		},
		dropdownOrString(
			'Recurrence Frequency',
			'recurrenceFrequency',
			'WEEKLY',
			[
				{ name: 'Daily', value: 'DAILY' },
				{ name: 'Weekly', value: 'WEEKLY' },
				{ name: 'Monthly', value: 'MONTHLY' },
				{ name: 'Yearly', value: 'YEARLY' },
			],
			showIf(['createEvent', 'updateEvent'], { recurringEvent: [true] }),
			'How often the event recurs.',
		),
		{
			displayName: 'Recurrence Interval',
			name: 'recurrenceInterval',
			type: 'number',
			typeOptions: { minValue: 1 },
			default: 1,
			displayOptions: showIf(['createEvent', 'updateEvent'], { recurringEvent: [true] }),
			description: 'Interval between recurrences (e.g. every 2 weeks)',
		},
		dropdownOrString(
			'Recurrence End Type',
			'recurrenceEndType',
			'never',
			[
				{ name: 'Never', value: 'never' },
				{ name: 'After N Occurrences', value: 'count' },
				{ name: 'On a Specific Date', value: 'until' },
			],
			showIf(['createEvent', 'updateEvent'], { recurringEvent: [true] }),
			'How the recurrence terminates.',
		),
		{
			displayName: 'Recurrence Count',
			name: 'recurrenceCount',
			type: 'number',
			typeOptions: { minValue: 1 },
			default: 10,
			displayOptions: showIf(['createEvent', 'updateEvent'], {
				recurringEvent: [true],
				recurrenceEndType: ['count'],
			}),
			description: 'Total number of occurrences (including the first)',
		},
		{
			displayName: 'Recurrence Until',
			name: 'recurrenceUntil',
			type: 'string',
			default: '',
			placeholder: '2026-12-31T23:59:59Z',
			displayOptions: showIf(['createEvent', 'updateEvent'], {
				recurringEvent: [true],
				recurrenceEndType: ['until'],
			}),
			description: 'Recurrence ends on or before this ISO datetime',
		},
		{
			displayName: 'Recurrence By Day',
			name: 'recurrenceByDay',
			type: 'string',
			default: '',
			placeholder: 'MO,WE,FR',
			displayOptions: showIf(['createEvent', 'updateEvent'], { recurringEvent: [true] }),
			description:
				'Comma-separated BYDAY tokens. Allowed values: MO, TU, WE, TH, FR, SA, SU. Tokens may be prefixed with an ordinal, e.g. 2MO or -1FR.',
		},
	];

	return properties;
}
