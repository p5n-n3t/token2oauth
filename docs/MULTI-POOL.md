# Multi-pool schema (foundation)

**Status in 0.2.0:** validation and the read-only migration preview are
available via `token2oauth pools preview`. Runtime routing, persistence of
named pools and per-pool OAuth audiences are not implemented yet; the gateway
still serves one default pool.

The new src/pool-schema.ts defines an opt-in schema boundary for future named
pools. It does not change the state store, HTTP routes, MCP proxy, or OAuth flow.

## Schema helpers

- validatePools(input, accounts) validates and defensively copies pool
  definitions against the current flat account list. IDs are caller-supplied
  stable identifiers; slugs are unique lowercase URL segments. A member account
  must exist, match the pool's provider, and belong to at most one pool.
- validateToolSets(pools, toolSets) checks pool/provider identity and rejects
  an unqualified tool name when it appears under different providers in an
  aggregate tool catalog. Separate pool endpoints may expose the same name
  because their routing context disambiguates it.
- migrateLegacyPool(state) maps the current v1 config and accounts to the
  deterministic legacy-default / default pool. It only reads the input and
  returns a new object. It rejects legacy accounts with multiple provider
  identities because one old global upstream configuration cannot determine
  their intended separation.

Validation throws PoolSchemaError, whose issues list names invalid fields
without including account secrets. The helper limits pools, accounts, tool
sets, and tools per set to bound input size. Settings are copied from the current
GatewayConfig routing, retry, timeout, and quota fields. basePath and
publicBaseUrl remain deployment-wide values.

## Future endpoint and OAuth boundary

Use one existing Funnel mount at the gateway's current /token2oauth base.
Route each named pool beneath it, for example:

~~~text
/token2oauth/pools/provider-a/mcp
/token2oauth/pools/provider-b/mcp
~~~

Treat each pool route as a distinct OAuth resource audience. Issue and validate
tokens against that exact resource URI, and use pool-specific scopes such as
pool:provider-a:mcp and pool:provider-b:mcp. A token authorized for one pool
should not authorize another pool's endpoint. This schema does not implement
those route checks, token claims, scopes, state migration on disk, account
reassignment, or Funnel configuration; those require separate runtime
integration.
