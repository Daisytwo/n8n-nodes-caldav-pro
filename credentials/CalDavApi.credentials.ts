import type {
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestOptions,
	INodeProperties,
} from 'n8n-workflow';

export class CalDavApi implements ICredentialType {
	name = 'calDavApi';

	displayName = 'CalDAV API';

	documentationUrl = 'https://github.com/daisytwo/n8n-nodes-caldav-pro';

	properties: INodeProperties[] = [
		{
			displayName: 'Server URL',
			name: 'serverUrl',
			type: 'string',
			default: 'https://sync.infomaniak.com/',
			placeholder: 'https://sync.infomaniak.com/',
			description:
				'Base URL of the CalDAV server. For Infomaniak use https://sync.infomaniak.com/. For NextCloud use https://<host>/remote.php/dav/. Must end with a slash.',
			required: true,
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: '',
			placeholder: 'abc12345',
			description:
				'IMPORTANT for Infomaniak: the SHORT username (e.g. "abc12345"), NOT your email address. Find it at https://config.infomaniak.com/ under Thunderbird or Apple profile. Using the email address is the #1 cause of "401 Unauthorized" errors.',
			required: true,
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Your CalDAV password. If 2FA is enabled on your account (Infomaniak, iCloud, Google), you MUST generate an app-specific password at the provider manager. Regular login passwords will be rejected.',
			required: true,
		},
	];

	/**
	 * Inject HTTP Basic auth into every outgoing request made via
	 * this.helpers.httpRequestWithAuthentication.
	 */
	async authenticate(
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> {
		const username = credentials.username as string;
		const password = credentials.password as string;
		const token = Buffer.from(`${username}:${password}`).toString('base64');
		requestOptions.headers = {
			...(requestOptions.headers ?? {}),
			Authorization: `Basic ${token}`,
		};
		return requestOptions;
	}

	/**
	 * n8n's credential test UI hook. PROPFIND on the principal URL so we get
	 * a clean HTTP 207 Multi-Status on success. A plain GET on the base URL
	 * would falsely pass for any public HTTPS server.
	 */
	test: ICredentialTestRequest = {
		request: {
			method: 'PROPFIND' as any,
			url: '={{$credentials.serverUrl.replace(/\\/$/, "")}}/',
			headers: {
				Depth: '0',
				'Content-Type': 'application/xml; charset=utf-8',
			},
			body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:current-user-principal/>
    <c:calendar-home-set/>
    <d:displayname/>
  </d:prop>
</d:propfind>`,
		},
		rules: [
			{
				type: 'responseCode',
				properties: {
					value: 401,
					message:
						'401 Unauthorized: Username or app password wrong. For Infomaniak the username is NOT the email address — see https://config.infomaniak.com/ for the correct short username (e.g. "abc12345").',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 404,
					message:
						'404 Not Found: the username path does not exist on this server. Check the username spelling (Infomaniak format is "abc12345").',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 403,
					message:
						'403 Forbidden: authentication succeeded but access to the principal is denied. Check account permissions.',
				},
			},
		],
	};
}
