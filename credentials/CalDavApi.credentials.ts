import {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class CalDavApi implements ICredentialType {
	name = 'calDavApi';
	displayName = 'CalDAV API';
	documentationUrl = 'https://github.com/n8n-community/n8n-nodes-caldav-pro';

	properties: INodeProperties[] = [
		{
			displayName: 'Server URL',
			name: 'serverUrl',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'https://caldav.infomaniak.com/calendar/<user>/<calendar-id>/',
			description:
				'Full URL of the CalDAV calendar collection. Must end with a trailing slash. Examples:\n' +
				'- Infomaniak: https://caldav.infomaniak.com/calendar/<user>/<calendar-id>/\n' +
				'- Nextcloud: https://cloud.example.com/remote.php/dav/calendars/<user>/<calendar>/\n' +
				'- iCloud: https://caldav.icloud.com/<principal-id>/calendars/<calendar>/\n' +
				'- Radicale/Baikal/SOGo: use the calendar collection URL',
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: '',
			required: true,
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			required: true,
			description:
				'Account password or app-specific password (recommended for Infomaniak / iCloud / Google).',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			auth: {
				username: '={{ $credentials.username }}',
				password: '={{ $credentials.password }}',
			},
			headers: {
				'User-Agent': 'n8n-nodes-caldav-pro/1.0.0',
			},
		},
	};

	// Simple PROPFIND against the collection URL; servers typically return 207 Multi-Status.
	// n8n's IHttpRequestMethods type historically does not include WebDAV verbs,
	// so we cast the literal where needed.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{ $credentials.serverUrl }}',
			url: '',
			method: 'PROPFIND' as ICredentialTestRequest['request']['method'],
			headers: {
				Depth: '0',
				'Content-Type': 'application/xml; charset=utf-8',
			},
			body:
				'<?xml version="1.0" encoding="utf-8" ?>' +
				'<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>',
		},
	};
}
