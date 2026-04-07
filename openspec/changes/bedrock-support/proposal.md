## Why

Claude Code users on AWS (enterprise customers, AWS employees, or teams with Bedrock access) cannot use ccxray today because Bedrock uses a completely different API surface — AWS SigV4 auth, different endpoint URLs, and a binary EventStream SSE protocol — so ccxray's Anthropic-only proxy silently bypasses them. Adding Bedrock as a backend lets these users get the same visibility, cost tracking, and interception features they would on direct Anthropic.

## What Changes

- **Bedrock backend mode**: When `BEDROCK_REGION` is set, `CLAUDE_CODE_USE_BEDROCK=1` is detected, or `--bedrock` flag is passed, ccxray transparently translates incoming Anthropic Messages API requests to Bedrock Runtime API format and forwards to AWS instead of `api.anthropic.com`. If `CLAUDE_CODE_USE_BEDROCK` is already in the environment, no extra config is needed.
- **Dual auth support**: SigV4 signing using AWS credentials from the default credential chain (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`, instance metadata, profile), OR bearer token auth via `AWS_BEARER_TOKEN_BEDROCK` for IAM Identity Center / SSO setups. Bearer token takes precedence when both are present.
- **Binary EventStream ↔ SSE translation**: Bedrock streaming responses use a binary-framed EventStream format; ccxray decodes it and re-emits standard `text/event-stream` SSE to Claude Code, and vice versa.
- **Model ID normalization**: Anthropic model IDs (e.g. `claude-opus-4`) are mapped to their Bedrock equivalents (e.g. `anthropic.claude-opus-4-...`) for routing, and normalized back for display in the dashboard.
- **Cross-account inference profile support**: Optional `BEDROCK_PROFILE_ARN` env var allows routing through a Bedrock cross-region inference profile ARN.
- **`ccxray claude --bedrock` shorthand**: Sets the right env vars and spawns Claude Code pointed at the proxy, same UX as regular `ccxray claude`.

## Capabilities

### New Capabilities

- `bedrock-proxy`: Accept Anthropic API format from Claude Code, translate to Bedrock Runtime API (SigV4 signing, URL rewriting, model ID mapping, binary EventStream ↔ SSE conversion), and forward to `bedrock-runtime.{region}.amazonaws.com`.

### Modified Capabilities

- `hub-lifecycle`: No requirement changes; hub mode continues to work unchanged with Bedrock backend.

## Impact

- **`server/config.js`**: New `BEDROCK_*` config vars (`BEDROCK_REGION`, `BEDROCK_PROFILE_ARN`, model ID map).
- **`server/forward.js`**: New Bedrock forwarding path alongside existing Anthropic path; binary EventStream parser.
- **`server/index.js`**: `--bedrock` flag detection; `spawnClaude` env augmentation.
- **`server/pricing.js`**: Bedrock model IDs need cost lookups (LiteLLM has Bedrock pricing under `bedrock/` prefix).
- **Dependencies**: No new npm deps — SigV4 signing and EventStream binary parsing implemented inline to preserve the zero-dependency constraint.
