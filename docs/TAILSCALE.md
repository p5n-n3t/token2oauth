# Tailscale deployment

Token2OAuth can use Tailscale Funnel for a public HTTPS MCP URL or Tailscale Serve for tailnet-only access.

References:
- https://tailscale.com/docs/reference/tailscale-cli/funnel
- https://tailscale.com/docs/reference/tailscale-cli/serve

## Coexisting with an existing root Funnel

If the machine already has:

~~~text
https://node.example.ts.net/
└── / → http://127.0.0.1:2025
~~~

add Token2OAuth without resetting it:

~~~bash
tailscale funnel --bg \
  --https=443 \
  --set-path=/token2oauth \
  http://127.0.0.1:2030
~~~

Result:

~~~text
https://node.example.ts.net/
├── /            → http://127.0.0.1:2025
└── /token2oauth → http://127.0.0.1:2030
~~~

The installer uses this additive pattern and never runs a Serve/Funnel reset.

Use Funnel when an internet client such as ChatGPT must reach the MCP server. Use Serve when every client is inside the tailnet.

~~~bash
token2oauth tailscale expose \
  --mode funnel \
  --path /token2oauth \
  --port 2030
~~~

Reverse proxies differ in whether they strip a path prefix. Token2OAuth publishes OAuth URLs from publicBaseUrl but accepts both prefixed and unprefixed local routes.

Check status with:

~~~bash
tailscale funnel status
token2oauth tailscale status
token2oauth doctor
~~~
