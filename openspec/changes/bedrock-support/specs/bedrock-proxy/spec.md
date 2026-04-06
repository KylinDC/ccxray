## ADDED Requirements

### Requirement: Bedrock mode activation
The system SHALL activate Bedrock backend mode when ANY of the following conditions are met: (1) `BEDROCK_REGION` is set to a non-empty string, (2) `CLAUDE_CODE_USE_BEDROCK` is set to `1` or `true`, (3) `--bedrock` CLI flag is passed. In Bedrock mode, all proxy forwarding targets `bedrock-runtime.{region}.amazonaws.com` instead of `api.anthropic.com`. The `ANTHROPIC_HOST`, `ANTHROPIC_PORT`, and `ANTHROPIC_PROTOCOL` config vars are ignored in Bedrock mode. When Bedrock mode is triggered without an explicit region, the system SHALL resolve the region in this order: `BEDROCK_REGION` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1` (default).

#### Scenario: Bedrock mode enabled via BEDROCK_REGION
- **WHEN** `BEDROCK_REGION=us-east-1` is set before starting ccxray
- **THEN** ccxray logs "Bedrock mode: us-east-1" at startup and all proxy requests are forwarded to Bedrock

#### Scenario: Bedrock mode auto-detected via CLAUDE_CODE_USE_BEDROCK
- **WHEN** `CLAUDE_CODE_USE_BEDROCK=1` is set (and `BEDROCK_REGION` is not set)
- **THEN** ccxray activates Bedrock mode, resolves the region from `AWS_REGION` or defaults to `us-east-1`, and logs "Bedrock mode: {region} (auto-detected via CLAUDE_CODE_USE_BEDROCK)"

#### Scenario: CLAUDE_CODE_USE_BEDROCK with explicit region
- **WHEN** both `CLAUDE_CODE_USE_BEDROCK=1` and `AWS_REGION=eu-west-1` are set
- **THEN** ccxray uses `eu-west-1` as the Bedrock region

#### Scenario: Bedrock mode not activated without any trigger
- **WHEN** none of `BEDROCK_REGION`, `CLAUDE_CODE_USE_BEDROCK`, or `--bedrock` are set
- **THEN** ccxray operates normally, forwarding to `api.anthropic.com`

#### Scenario: Missing auth in Bedrock mode
- **WHEN** Bedrock mode is activated but neither AWS credentials nor `BEDROCK_BEARER_TOKEN` are resolvable
- **THEN** ccxray exits at startup with error "Bedrock mode requires auth. Set BEDROCK_BEARER_TOKEN, AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or configure ~/.aws/credentials"

### Requirement: Bearer token authentication
The system SHALL support AWS Bedrock bearer token authentication via the `BEDROCK_BEARER_TOKEN` environment variable. When `BEDROCK_BEARER_TOKEN` is set, the system SHALL attach `Authorization: Bearer {token}` to every forwarded Bedrock request and SHALL skip SigV4 signing entirely. Bearer token auth takes precedence over SigV4 when both are present.

#### Scenario: Bearer token used when set
- **WHEN** `BEDROCK_BEARER_TOKEN=eyJ...` is set
- **THEN** every forwarded Bedrock request contains `Authorization: Bearer eyJ...` and no SigV4 Authorization header or `X-Amz-*` headers are added

#### Scenario: Bearer token takes precedence over SigV4 credentials
- **WHEN** both `BEDROCK_BEARER_TOKEN` and `AWS_ACCESS_KEY_ID` are set
- **THEN** the forwarded request uses Bearer auth (not SigV4), and a debug log notes "Using bearer token auth (BEDROCK_BEARER_TOKEN)"

#### Scenario: No credential check when bearer token is set
- **WHEN** `BEDROCK_BEARER_TOKEN` is set and AWS credentials are not present
- **THEN** ccxray starts successfully without attempting credential resolution

### Requirement: AWS SigV4 request signing
The system SHALL sign every request forwarded to Bedrock using AWS Signature Version 4 with service `bedrock` and the configured region when `BEDROCK_BEARER_TOKEN` is not set. Signing SHALL use credentials resolved from the environment in this order: (1) `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` + optional `AWS_SESSION_TOKEN`, (2) AWS shared credentials file at `~/.aws/credentials` using profile `AWS_PROFILE` or `default`, (3) EC2/ECS instance metadata (IMDSv2, 1s timeout).

#### Scenario: Request signed with explicit env credentials
- **WHEN** `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are set and `BEDROCK_BEARER_TOKEN` is not set
- **THEN** the forwarded request contains a valid `Authorization: AWS4-HMAC-SHA256 ...` header with the correct credential scope and HMAC signature

#### Scenario: Request signed with profile credentials
- **WHEN** `AWS_ACCESS_KEY_ID` is not set, `BEDROCK_BEARER_TOKEN` is not set, but `~/.aws/credentials` contains a `[default]` profile with valid keys
- **THEN** the forwarded request is signed using those profile credentials

#### Scenario: Session token included when present
- **WHEN** `AWS_SESSION_TOKEN` is set (e.g. temporary STS credentials)
- **THEN** the forwarded request includes `X-Amz-Security-Token: {token}` header alongside the Authorization header

### Requirement: Anthropic-to-Bedrock URL translation
The system SHALL rewrite the incoming request URL from Anthropic format to Bedrock format before forwarding. The Anthropic endpoint `/v1/messages` SHALL be translated to `/model/{bedrockModelId}/invoke-with-response-stream`. If `BEDROCK_PROFILE_ARN` is set, the model segment SHALL be URL-encoded ARN: `/model/{encodedArn}/invoke-with-response-stream`.

#### Scenario: Standard model URL translation
- **WHEN** a request arrives at `/v1/messages` with model `claude-3-5-sonnet-20241022` and `BEDROCK_REGION=us-east-1`
- **THEN** the request is forwarded to `https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke-with-response-stream`

#### Scenario: Cross-region inference profile URL
- **WHEN** `BEDROCK_PROFILE_ARN=arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0` is set
- **THEN** the ARN is URL-encoded and used as the model segment in the Bedrock URL

#### Scenario: Unknown Anthropic model ID with BEDROCK_MODEL_ID override
- **WHEN** the request contains a model ID not in the built-in mapping table, and `BEDROCK_MODEL_ID` is set to a Bedrock model ID
- **THEN** the override value is used as the Bedrock model ID

#### Scenario: Unknown model ID without override
- **WHEN** the request model ID is not in the mapping table and `BEDROCK_MODEL_ID` is not set
- **THEN** ccxray responds with HTTP 400 and error `{"error": "bedrock_model_unknown", "message": "No Bedrock model ID for 'claude-xyz'. Set BEDROCK_MODEL_ID to override."}`

### Requirement: Anthropic-to-Bedrock model ID mapping
The system SHALL maintain a built-in mapping table from Anthropic model short names to Bedrock model IDs. The mapping SHALL support prefix matching (e.g. `claude-3-5-sonnet` matches `claude-3-5-sonnet-20241022`). The initial table SHALL include at minimum: Claude 3 Haiku, Claude 3 Sonnet, Claude 3 Opus, Claude 3.5 Haiku, Claude 3.5 Sonnet (v1 and v2), Claude 3.7 Sonnet, Claude Opus 4, Claude Sonnet 4, Claude Haiku 4.

#### Scenario: Exact model ID match
- **WHEN** the request model is `claude-3-5-sonnet-20241022`
- **THEN** the Bedrock model ID `anthropic.claude-3-5-sonnet-20241022-v2:0` is used

#### Scenario: Prefix match for versioned model
- **WHEN** the request model is `claude-3-opus-20240229` and the table has prefix `claude-3-opus`
- **THEN** the corresponding Bedrock model ID is resolved via prefix match

### Requirement: Bedrock binary EventStream response decoding
The system SHALL decode AWS binary EventStream frames from Bedrock streaming responses and re-emit the contained Anthropic SSE events as standard `text/event-stream` to the Claude Code client. Each binary frame contains a JSON payload `{"bytes": "<base64>"}` where the base64-decoded value is the Anthropic SSE event JSON. The system SHALL handle frame boundaries that span multiple TCP chunks.

#### Scenario: Streaming response decoded and forwarded
- **WHEN** Bedrock sends a streaming response with binary EventStream frames
- **THEN** ccxray decodes each frame, extracts the base64 payload, decodes it, and writes the corresponding `data: {...}\n\n` SSE event to the Claude Code client

#### Scenario: Frame spans two chunks
- **WHEN** a single binary EventStream frame is split across two TCP data events
- **THEN** ccxray buffers the incomplete frame and correctly decodes it once the remaining bytes arrive

#### Scenario: CRC32 mismatch on corrupted frame
- **WHEN** a binary frame's CRC32 does not match its computed checksum
- **THEN** ccxray logs a warning `BEDROCK STREAM: CRC32 mismatch, skipping frame` and continues processing subsequent frames

#### Scenario: Bedrock error event in stream
- **WHEN** Bedrock sends a frame with `:event-type: modelStreamErrorException`
- **THEN** ccxray extracts the error message, ends the stream, and logs the error

### Requirement: Request header translation for Bedrock
The system SHALL translate outgoing request headers for Bedrock compatibility. The `x-api-key` header SHALL be removed. The `anthropic-version` header SHALL be removed. The `Content-Type` SHALL be `application/json`. An `Accept` header of `application/vnd.amazon.eventstream` SHALL be added for streaming requests. The `Authorization` header SHALL be set to either the SigV4 value or `Bearer {token}` depending on which auth method is active.

#### Scenario: Anthropic-specific headers removed
- **WHEN** Claude Code sends `x-api-key` and `anthropic-version` headers
- **THEN** the forwarded Bedrock request does not contain those headers

#### Scenario: Correct content negotiation headers set
- **WHEN** forwarding a streaming request to Bedrock
- **THEN** the request contains `Accept: application/vnd.amazon.eventstream`

#### Scenario: Authorization header with bearer token
- **WHEN** `BEDROCK_BEARER_TOKEN` is set
- **THEN** the forwarded request has `Authorization: Bearer {token}` and no `X-Amz-Date` or `X-Amz-Security-Token` headers

### Requirement: Dashboard and logging compatibility in Bedrock mode
The system SHALL record, display, and broadcast Bedrock-proxied requests identically to Anthropic-proxied requests in the dashboard. The logged model ID SHALL be the Anthropic model ID (not the Bedrock ID) for consistency. Cost SHALL be calculated using Bedrock-specific pricing from the LiteLLM price table (`bedrock/anthropic.claude-*` keys). The rate limit ticker SHALL be hidden/empty in Bedrock mode (Bedrock does not return `anthropic-ratelimit-*` headers).

#### Scenario: Turn recorded in dashboard
- **WHEN** a Bedrock-proxied request completes
- **THEN** the turn appears in the dashboard with correct model name, token counts, and cost estimate

#### Scenario: Cost uses Bedrock pricing
- **WHEN** calculating cost for a Bedrock turn with model `claude-3-5-sonnet-20241022`
- **THEN** the cost is looked up using the Bedrock pricing key `bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0`

#### Scenario: Rate limit ticker hidden in Bedrock mode
- **WHEN** ccxray is in Bedrock mode
- **THEN** the quota ticker in the dashboard topbar is not shown (or shows "—")

### Requirement: `ccxray claude --bedrock` shorthand
The system SHALL accept a `--bedrock` flag in `ccxray claude` mode. When present, it SHALL ensure `BEDROCK_REGION` is set (defaulting to `us-east-1` if not already in env), validate credentials, and spawn Claude Code with `ANTHROPIC_BASE_URL` pointed at the proxy. All other `ccxray claude` flags SHALL remain valid alongside `--bedrock`.

#### Scenario: Bedrock flag sets region default
- **WHEN** `ccxray claude --bedrock` is run without `BEDROCK_REGION` set
- **THEN** ccxray logs "Bedrock mode: us-east-1 (default)" and uses `us-east-1`

#### Scenario: Explicit region takes precedence
- **WHEN** `BEDROCK_REGION=eu-west-1 ccxray claude --bedrock` is run
- **THEN** ccxray uses `eu-west-1`, not the default

#### Scenario: Claude Code spawned with correct env
- **WHEN** `ccxray claude --bedrock` succeeds
- **THEN** the spawned `claude` process receives `ANTHROPIC_BASE_URL=http://localhost:{port}` and standard Anthropic API format is used (no Bedrock SDK config needed in Claude Code)
