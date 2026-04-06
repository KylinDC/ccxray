## Context

ccxray is a transparent HTTP proxy that intercepts Claude Code traffic and records it for the dashboard. Today, all traffic is forwarded to `api.anthropic.com` using the Anthropic Messages API (REST + `text/event-stream` SSE). 

AWS Bedrock exposes the same Claude models through an entirely different API surface:
- **Auth**: AWS SigV4 HMAC request signing (not `x-api-key`)
- **Endpoint**: `https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/invoke-with-response-stream`
- **Model IDs**: `anthropic.claude-3-5-sonnet-20241022-v2:0` (Bedrock format) vs `claude-3-5-sonnet-20241022` (Anthropic format)
- **Streaming protocol**: AWS binary EventStream (not `text/event-stream`). The SSE event payloads are identical to Anthropic's, but wrapped in an AWS binary frame.

Claude Code, when `ANTHROPIC_BASE_URL` is set, always sends standard Anthropic API format to that URL. This means ccxray can act as a **translation layer**: accept standard Anthropic format from Claude Code → translate and sign → forward to Bedrock → parse binary response → re-emit as standard SSE to Claude Code.

The zero-dependency constraint (no npm packages beyond Node.js) is maintained throughout.

## Goals / Non-Goals

**Goals:**
- Support Claude Code (and other Anthropic API clients) routing through Bedrock when `BEDROCK_REGION` env var is set
- Implement AWS SigV4 signing in pure Node.js (crypto module only)
- Parse AWS binary EventStream and convert to standard SSE
- Map Anthropic model IDs to Bedrock model IDs (with override via env)
- Support cross-region inference profile ARNs via `BEDROCK_PROFILE_ARN`
- `ccxray claude --bedrock` shorthand for convenient startup
- All existing features (logging, dashboard, cost tracking, intercept) work transparently with Bedrock

**Non-Goals:**
- Supporting non-Claude models on Bedrock (Titan, Cohere, Llama, etc.)
- Replacing the AWS SDK (this implementation is purpose-built for the Bedrock Claude path only)
- Implementing IAM role assumption at runtime (ambient credentials only: env, instance metadata, profile)
- Supporting Bedrock Agents or other Bedrock services beyond Runtime invoke

## Decisions

### Decision 1: Translation in `forward.js`, not a new module

**Choice**: Add a `forwardBedrockRequest()` function inside `server/forward.js`, sharing the same SSE parsing, entry creation, and broadcast logic as the existing `forwardRequest()`.

**Alternatives considered**:
- *New module `server/forward-bedrock.js`*: Cleaner separation but leads to duplicated entry/broadcast logic. Rejected.
- *Middleware layer that transforms the request before `forwardRequest()`*: Would require converting binary EventStream back to SSE mid-stream, complex interleaving. Rejected.

**Rationale**: The Bedrock path diverges only at the HTTP transport layer (SigV4, different host/path, binary decode). Everything above (session detection, intercept, logging, entry creation) is identical and can be reused by sharing the `ctx` object.

### Decision 2: SigV4 implemented in `server/sigv4.js` (pure Node.js)

**Choice**: Extract a minimal, self-contained SigV4 signing function using Node's built-in `crypto` module.

**Alternatives considered**:
- *`@aws-sdk/signature-v4` package*: Correct and maintained, but breaks the zero-dependency constraint. Rejected.
- *Inline into `forward.js`*: Would bloat the forwarding module. Rejected.

**Rationale**: SigV4 is a well-defined algorithm (HMAC-SHA256, canonical request format). A purpose-built ~100-line implementation is sufficient for this use case and adds no dependencies.

### Decision 3: AWS binary EventStream parsed inline in `forward.js`

**Choice**: Parse the binary EventStream format (length-prefixed frames with CRC32 validation) in `handleBedrockSSEResponse()` alongside existing chunk handling.

**Bedrock EventStream frame format**:
```
[4 bytes: total length] [4 bytes: header length] [4 bytes: prelude CRC]
[N bytes: headers] [M bytes: payload] [4 bytes: message CRC]
```
Headers are length-prefixed name-value pairs. The `:event-type` header contains `chunk`. The payload is a JSON object `{ bytes: "<base64>" }` where the base64-decoded content is the standard Anthropic SSE event payload.

**Alternatives considered**:
- *Treat Bedrock response as SSE text*: Bedrock uses binary framing, this would not work.
- *`@aws-sdk/eventstream-codec` package*: Correct, but introduces a dependency. Rejected.

**Rationale**: The frame structure is simple and stable; implementing it inline avoids dependencies and makes the data flow explicit.

### Decision 4: Model ID mapping via a static table + env override

**Choice**: Maintain a mapping table in `server/config.js` from Anthropic short names to Bedrock model IDs. Allow override via `BEDROCK_MODEL_ID` env var (for unknown/new models).

**Bedrock model ID format**: `anthropic.claude-{variant}-{date}-v{version}:{minor}` e.g. `anthropic.claude-3-5-sonnet-20241022-v2:0`

**Alternatives considered**:
- *Dynamic lookup from Bedrock API*: Adds latency and complexity. Rejected.
- *Require users to set the full Bedrock ID*: Poor UX; Anthropic model IDs should just work. Rejected.

**Rationale**: The mapping table is small and rarely changes; it aligns with the existing `MODEL_CONTEXT_FALLBACK` table in config.js. New models can be added on the same cadence as context window updates.

### Decision 5: Auth method selection — bearer token vs SigV4

**Choice**: Two mutually exclusive auth paths, bearer token taking precedence:
- If `BEDROCK_BEARER_TOKEN` is set → attach `Authorization: Bearer {token}`; skip all SigV4 and credential resolution entirely.
- Otherwise → resolve AWS credentials and sign with SigV4.

Credential resolution order (SigV4 path only):
1. `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ optional `AWS_SESSION_TOKEN`)
2. AWS shared credentials file (`~/.aws/credentials`, profile from `AWS_PROFILE` or `default`)
3. EC2/ECS instance metadata (IMDS v2, with 1s timeout)

**Rationale**: Bearer tokens are used by IAM Identity Center (SSO) and some Bedrock gateway setups that vend short-lived tokens instead of AWS key pairs. Making this a first-class path avoids forcing SSO users through SigV4. Precedence order ensures users who set `BEDROCK_BEARER_TOKEN` don't get unexpected SigV4 failures if stale AWS env vars are also present.

### Decision 6: Bedrock mode activation triggers

**Choice**: Bedrock mode activates when ANY of: `BEDROCK_REGION` is set, `CLAUDE_CODE_USE_BEDROCK` is `1`/`true`, or `--bedrock` CLI flag is passed. Region is resolved from: `BEDROCK_REGION` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`.

**Rationale**: `CLAUDE_CODE_USE_BEDROCK` is Claude Code's own env var for Bedrock mode. If a user already has this set in their environment (e.g. in `.env` or shell profile), ccxray should auto-detect it without requiring them to also set `BEDROCK_REGION`. This makes ccxray a drop-in for existing Bedrock-configured Claude Code setups.

### Decision 6: `--bedrock` flag for `ccxray claude`

**Choice**: `ccxray claude --bedrock [args...]` sets `BEDROCK_REGION` (from env or `us-east-1` default), resolves credentials, and spawns Claude Code with `ANTHROPIC_BASE_URL` pointed at the proxy.

**Rationale**: Same UX as existing `ccxray claude`. Claude Code doesn't need any Bedrock-specific configuration; it sends standard Anthropic API requests and ccxray handles the backend.

## Risks / Trade-offs

- **CRC32 validation**: AWS EventStream includes CRC32 checksums per frame. A mismatch indicates corruption. Risk → ccxray will log a warning and skip the corrupted frame (same behavior as a malformed SSE event today).
- **Credential staleness**: STS/IMDS tokens expire. Risk → Credential refresh on each request (re-read env/file); IMDS credentials cached for their reported TTL.
- **New Bedrock model IDs**: The mapping table will lag new model releases. Risk → `BEDROCK_MODEL_ID` override lets users unblock themselves; table updated on each ccxray release.
- **Bedrock cross-region inference profiles**: ARN-based routing changes the URL path shape. Risk → Handled via `BEDROCK_PROFILE_ARN` which replaces the model segment in the URL.
- **Rate limit headers**: Bedrock doesn't return `anthropic-ratelimit-*` headers. The quota ticker in the dashboard will show no data in Bedrock mode. Risk → Acceptable; document this limitation.
- **Cost display**: Bedrock pricing differs from direct Anthropic. LiteLLM pricing data includes Bedrock rates under `bedrock/anthropic.claude-*` keys. Risk → Map Bedrock model IDs to LiteLLM's Bedrock pricing keys in `pricing.js`.

## Migration Plan

1. Feature is opt-in: existing users unaffected (Bedrock mode activates only when `BEDROCK_REGION` is set).
2. No data format changes; existing logs remain compatible.
3. No hub changes; Bedrock-mode clients connect to the same hub.

## Open Questions

- Should ccxray support Bedrock's "on-demand" vs "provisioned throughput" modes? Provisioned throughput uses a different ARN format. Low priority; document as unsupported for now.
- Is there a use case for mixing Anthropic and Bedrock backends in the same hub session? Probably not; flag as unsupported.
