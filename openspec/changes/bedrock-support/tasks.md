## 1. Configuration and Credential Resolution

- [x] 1.1 Add `BEDROCK_REGION`, `BEDROCK_PROFILE_ARN`, `BEDROCK_MODEL_ID`, `AWS_BEARER_TOKEN_BEDROCK` env vars to `server/config.js`; set `IS_BEDROCK_MODE = !!(BEDROCK_REGION || CLAUDE_CODE_USE_BEDROCK === '1' || CLAUDE_CODE_USE_BEDROCK === 'true' || bedrockFlag)`
- [x] 1.2 Add region resolution logic in `server/config.js`: `BEDROCK_REGION` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `'us-east-1'`; export resolved `BEDROCK_RESOLVED_REGION`
- [x] 1.3 Add Anthropic→Bedrock model ID mapping table in `server/config.js` (Claude 3 Haiku/Sonnet/Opus, 3.5 Haiku/Sonnet v1+v2, 3.7 Sonnet, Opus 4, Sonnet 4, Haiku 4)
- [x] 1.4 Implement credential resolver in `server/bedrock-credentials.js`: env vars → `~/.aws/credentials` file → IMDSv2 (1s timeout); resolver is skipped entirely when `AWS_BEARER_TOKEN_BEDROCK` is set
- [x] 1.5 In `server/index.js` startup, when `IS_BEDROCK_MODE`: if `AWS_BEARER_TOKEN_BEDROCK` is set log "Bedrock mode: {region} (bearer token auth)"; else resolve credentials and exit with error if none found; log activation source (BEDROCK_REGION / CLAUDE_CODE_USE_BEDROCK / --bedrock flag)

## 2. SigV4 Request Signing

- [x] 2.1 Create `server/sigv4.js` with a `sign(method, url, headers, body, credentials, region, service)` function using Node's `crypto` module (HMAC-SHA256)
- [x] 2.2 Implement canonical request construction: sorted headers, URI encoding, payload hash
- [x] 2.3 Implement string-to-sign and signing key derivation (date key → region key → service key → signing key)
- [x] 2.4 Produce and return `Authorization` header value in `AWS4-HMAC-SHA256` format, plus `X-Amz-Date` and optional `X-Amz-Security-Token`

## 3. Bedrock Request Translation

- [x] 3.1 Add `resolveBedrockModelId(anthropicModelId)` helper in `server/config.js` using the mapping table (longest-prefix match); throw on unknown if no `BEDROCK_MODEL_ID` override
- [x] 3.2 Add `buildBedrockUrl(region, modelId, profileArn)` helper that constructs the correct Bedrock endpoint URL
- [x] 3.3 In `forwardBedrockRequest()` (new function in `server/forward.js`): strip incoming `x-api-key`, `anthropic-version`, `authorization` headers; set `Content-Type: application/json`, `Accept: application/vnd.amazon.eventstream`
- [x] 3.4 Auth header selection: if `AWS_BEARER_TOKEN_BEDROCK` is set, add `Authorization: Bearer {token}`; otherwise call `sigv4.sign()` and add the resulting `Authorization`, `X-Amz-Date`, and optional `X-Amz-Security-Token` headers
- [x] 3.5 Handle `resolveBedrockModelId` error: respond HTTP 400 with `bedrock_model_unknown` JSON error

## 4. Binary EventStream Decoder

- [x] 4.1 Create `server/eventstream.js` with `EventStreamDecoder` class: stateful binary frame parser with internal buffer
- [x] 4.2 Implement frame parsing: read 4-byte prelude (total-length, header-length), validate prelude CRC32, extract headers, extract payload, validate message CRC32
- [x] 4.3 Implement CRC32 calculation in `eventstream.js` (pure JS, using the standard polynomial `0xEDB88320`)
- [x] 4.4 Implement header parsing: length-prefixed name (uint8 len), value-type byte (`7` = string), value (uint16 len + bytes)
- [x] 4.5 Implement payload extraction: parse `{"bytes": "<base64>"}` JSON, base64-decode to get Anthropic SSE event JSON
- [x] 4.6 Expose `decoder.push(chunk)` method that returns an array of decoded Anthropic event objects (or error descriptors)

## 5. Bedrock Response Handling

- [x] 5.1 Add `handleBedrockSSEResponse()` in `server/forward.js`: create `EventStreamDecoder`, pipe `proxyRes` data through it
- [x] 5.2 For each decoded Anthropic event, re-emit as standard `data: {...}\n\n` SSE to `clientRes` (reuse existing held-events logic for `message_delta`/`message_stop`)
- [x] 5.3 Handle `modelStreamErrorException` event type: extract error message, end stream, log warning
- [x] 5.4 Handle CRC32 mismatch: log warning `BEDROCK STREAM: CRC32 mismatch, skipping frame`, continue processing
- [x] 5.5 Ensure `proxyRes` error events are handled identically to the existing SSE path (decrement active requests, end client response)

## 6. Entry Creation and Dashboard Compatibility

- [x] 6.1 After Bedrock response completes, call existing `helpers.parseSSEEvents()`, `helpers.extractUsage()`, `helpers.calculateCost()` with the re-assembled SSE events — no changes needed to those helpers
- [x] 6.2 Update `server/pricing.js`: add Bedrock price key lookup (`bedrock/anthropic.claude-*`) in `calculateCost()` as fallback when in Bedrock mode
- [x] 6.3 In `server/sse-broadcast.js` (or store init), set a `IS_BEDROCK_MODE` flag that the dashboard can read via `/_api/config` to hide the rate limit ticker
- [x] 6.4 Update `/_api/config` route (or `window.__PROXY_CONFIG__` injection) to include `bedrockMode: true/false` so the dashboard quota ticker can hide itself

## 7. CLI: `--bedrock` Flag and Auto-Detection

- [x] 7.1 In `server/index.js` CLI parsing, detect `--bedrock` in `process.argv`; remove it from the args list before passing to Claude
- [x] 7.2 `IS_BEDROCK_MODE` is also true when `CLAUDE_CODE_USE_BEDROCK` is `1` or `true` in the environment — no extra CLI parsing needed for this case; the config module handles it
- [x] 7.3 When Bedrock mode is active (any trigger) and `BEDROCK_REGION` is not set, fall through region resolution: `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`
- [x] 7.4 In `spawnClaude()`, when in Bedrock mode, do NOT pass `AWS_*` env vars to the child process (Claude Code should not independently attempt Bedrock SDK usage)

## 8. Main Forward Entry Point

- [x] 8.1 In `server/forward.js` `forwardRequest()`, check `config.IS_BEDROCK_MODE`; if true, call `forwardBedrockRequest(ctx)` instead of the existing Anthropic path
- [x] 8.2 Ensure quota-check probe bypass (`ctx.skipEntry`) is preserved in the Bedrock path

## 9. Unit Tests: `test/sigv4.test.js`

- [x] 9.1 Canonical request: verify URI encoding, header sorting, and payload hash using the [AWS SigV4 test suite](https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html) reference vector
- [x] 9.2 String-to-sign: verify date scope, credential scope, and hashed canonical request match the reference vector
- [x] 9.3 Signing key derivation: verify HMAC chain (date → region → service → `aws4_request`) matches the reference vector
- [x] 9.4 Full Authorization header output: verify `AWS4-HMAC-SHA256 Credential=.../SignedHeaders=.../Signature=...` format for a known input
- [x] 9.5 `X-Amz-Security-Token` is included in signed headers and Authorization when `sessionToken` is provided
- [x] 9.6 `X-Amz-Security-Token` is absent from signed headers and Authorization when no session token

## 10. Unit Tests: `test/eventstream.test.js`

- [x] 10.1 Decode a single complete binary frame: verify correct prelude CRC, header parsing, base64 payload extraction, and returned event JSON
- [x] 10.2 Decode multiple frames in one `push()` call: verify all events are returned in order
- [x] 10.3 Frame split across two `push()` calls: first push contains partial frame bytes, second push contains remainder; verify single event returned only after second push
- [x] 10.4 Frame split at prelude boundary (only 2 of 12 prelude bytes in first push): verify buffering and correct decode after second push
- [x] 10.5 CRC32 mismatch on message CRC: verify decoder returns an error descriptor `{ error: 'crc_mismatch' }` and does not throw
- [x] 10.6 Prelude CRC mismatch: same as above — error descriptor returned, decoder continues
- [x] 10.7 `:event-type: modelStreamErrorException` frame: verify decoder returns `{ error: 'modelStreamErrorException', message: '...' }` descriptor
- [x] 10.8 Empty payload frame (e.g. `:event-type: initial-response`): verify no crash, empty event skipped

## 11. Unit Tests: `test/bedrock-config.test.js`

- [x] 11.1 `IS_BEDROCK_MODE` is `true` when `BEDROCK_REGION` is set
- [x] 11.2 `IS_BEDROCK_MODE` is `true` when `CLAUDE_CODE_USE_BEDROCK=1`
- [x] 11.3 `IS_BEDROCK_MODE` is `true` when `CLAUDE_CODE_USE_BEDROCK=true`
- [x] 11.4 `IS_BEDROCK_MODE` is `false` when neither env var is set (and no `--bedrock` flag)
- [x] 11.5 Region resolution: `BEDROCK_REGION` wins over `AWS_REGION` wins over `AWS_DEFAULT_REGION` wins over `us-east-1`
- [x] 11.6 Region resolution: when only `AWS_REGION=eu-west-1` is set, resolved region is `eu-west-1`
- [x] 11.7 `resolveBedrockModelId`: exact match returns correct Bedrock ID
- [x] 11.8 `resolveBedrockModelId`: prefix match (e.g. `claude-3-opus-20240229` matches prefix `claude-3-opus`)
- [x] 11.9 `resolveBedrockModelId`: unknown model, `BEDROCK_MODEL_ID` override set → returns override value
- [x] 11.10 `resolveBedrockModelId`: unknown model, no override → throws with message containing model name
- [x] 11.11 `buildBedrockUrl`: standard model ID → correct URL shape
- [x] 11.12 `buildBedrockUrl`: `BEDROCK_PROFILE_ARN` set → ARN is URL-encoded in path

## 12. Unit Tests: `test/bedrock-credentials.test.js`

- [x] 12.1 Resolver returns env var credentials when `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are set
- [x] 12.2 Resolver includes `sessionToken` when `AWS_SESSION_TOKEN` is set
- [x] 12.3 Resolver falls back to `~/.aws/credentials` `[default]` profile when env vars absent (use a temp file)
- [x] 12.4 Resolver reads named profile when `AWS_PROFILE` is set (use a temp credentials file with two profiles)
- [x] 12.5 Resolver returns `null` when no env vars, no credentials file, and IMDS times out (mock IMDS with a port that drops connections)
- [x] 12.6 Resolver is skipped (returns `null` without error) when `AWS_BEARER_TOKEN_BEDROCK` is set (caller decides to skip)

## 13. Integration Tests: `test/bedrock.test.js` — startup and auth

- [x] 13.1 Bedrock mode startup with `AWS_BEARER_TOKEN_BEDROCK`: ccxray starts, health endpoint responds, startup log contains "bearer token auth"
- [x] 13.2 Bedrock mode startup with `AWS_ACCESS_KEY_ID`+`AWS_SECRET_ACCESS_KEY`: ccxray starts successfully
- [x] 13.3 Bedrock mode startup with no credentials and no bearer token: ccxray exits with code 1 and stderr contains actionable error message
- [x] 13.4 `CLAUDE_CODE_USE_BEDROCK=1` without `BEDROCK_REGION` but with `AWS_REGION=ap-northeast-1`: startup log contains "ap-northeast-1" and "auto-detected via CLAUDE_CODE_USE_BEDROCK"
- [x] 13.5 `/_api/config` (or `window.__PROXY_CONFIG__`) returns `{ bedrockMode: true }` when Bedrock mode is active

## 14. Integration Tests: `test/bedrock.test.js` — end-to-end proxy with mock Bedrock

Each test in this group: spawn ccxray with `BEDROCK_REGION=us-east-1` + `AWS_BEARER_TOKEN_BEDROCK=test-token`, start a mock HTTP server that simulates `bedrock-runtime.us-east-1.amazonaws.com`, point ccxray at it via `BEDROCK_TEST_HOST`/`BEDROCK_TEST_PORT` env vars (similar pattern to `ANTHROPIC_TEST_HOST`).

- [x] 14.1 **Header translation**: mock Bedrock server records incoming headers; verify `x-api-key` and `anthropic-version` are absent, `Authorization: Bearer test-token` is present, `Accept: application/vnd.amazon.eventstream` is present
- [x] 14.2 **URL rewrite**: verify request arrived at `/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke-with-response-stream` (not `/v1/messages`)
- [x] 14.3 **SigV4 auth**: spawn with `AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE` + `AWS_SECRET_ACCESS_KEY=test`; verify `Authorization` header starts with `AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/`
- [x] 14.4 **Bearer wins over SigV4**: both `AWS_BEARER_TOKEN_BEDROCK` and AWS key env vars set; verify `Authorization: Bearer ...` (not SigV4)
- [x] 14.5 **Streaming response decoded**: mock returns a binary EventStream with 3 Anthropic SSE event frames; verify client receives correct `text/event-stream` with all 3 events in order
- [x] 14.6 **Frame boundary handling**: mock sends binary EventStream in two TCP writes split mid-frame; verify client still receives all events correctly
- [x] 14.7 **Dashboard entry created**: after a complete Bedrock streaming round-trip, verify `/_api/entries` returns one entry with correct `model`, `usage.input_tokens`, and `usage.output_tokens`
- [x] 14.8 **Unknown model → 400**: send request with model `claude-xyz-unknown` (not in mapping, no override); verify ccxray responds 400 with `bedrock_model_unknown` before hitting mock Bedrock
- [x] 14.9 **BEDROCK_PROFILE_ARN routing**: set `BEDROCK_PROFILE_ARN=arn:aws:bedrock:us-east-1::...`; verify URL path uses URL-encoded ARN
- [x] 14.10 **Bedrock error event**: mock returns a binary frame with `:event-type: modelStreamErrorException`; verify ccxray ends the stream cleanly and does not crash (health check passes after)
- [x] 14.11 **Rate limit headers absent**: after a Bedrock round-trip, verify `store.rateLimitState` is not updated (Bedrock sends no `anthropic-ratelimit-*` headers)
