# Security

Early local-only preview. Bind localhost, do not expose with a public reverse proxy. Credentials are read only by backend transport; they are not copied into public source/state. Provider output is allowlisted. Task text renders as textContent, not HTML.

Mutations require exact local Origin plus a private control token. Host checks reduce DNS-rebinding exposure. Read-only task data remains accessible to local processes: use only trusted machines and do not expose the port. SQLite state and task prompts may be sensitive. Never upload local state to GitHub.

No automatic arbitrary command execution or universal chat injection. Report security issues privately to the repository owner before publishing sensitive evidence.
