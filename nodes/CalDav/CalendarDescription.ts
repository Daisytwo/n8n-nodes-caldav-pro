import type { INodeProperties } from 'n8n-workflow';

export const calendarOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: {
				resource: ['calendar'],
			},
		},
		options: [
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'List many CalDAV calendars available to the authenticated user',
				action: 'Get many calendars',
			},
		],
		default: 'getAll',
	},
];

export const calendarFields: INodeProperties[] = [];
