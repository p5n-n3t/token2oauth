# Contributing

Contributions are welcome.

## Development

~~~bash
npm install
npm test
npm run dev
~~~

Node.js 22 or newer is required.

## Pull requests

Keep provider credentials and OAuth credentials out of fixtures and logs. Add tests for authentication or routing changes. Preserve MCP session affinity unless a change explicitly handles state migration. Document new CLI switches and persistent settings.

## Provider adapters

Prefer documented observable behavior: official usage endpoints, explicit error codes, Retry-After, and documented reset times. Avoid scraping dashboards or relying on brittle private UI endpoints.
