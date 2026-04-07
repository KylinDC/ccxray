'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { createStorage } = require('./storage');

// ── Config ──────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PROXY_PORT || '5577', 10);
const ANTHROPIC_HOST = process.env.ANTHROPIC_TEST_HOST || 'api.anthropic.com';
const ANTHROPIC_PORT = parseInt(process.env.ANTHROPIC_TEST_PORT || '443', 10);
const ANTHROPIC_PROTOCOL = process.env.ANTHROPIC_TEST_PROTOCOL || 'https';
const LOGS_DIR = path.join(os.homedir(), '.ccxray', 'logs');
const LEGACY_LOGS_DIR = path.join(__dirname, '..', 'logs');
const RESTORE_DAYS = parseInt(process.env.RESTORE_DAYS || '3', 10);

// ── Bedrock config ───────────────────────────────────────────────────
const BEDROCK_REGION = process.env.BEDROCK_REGION || '';
const BEDROCK_PROFILE_ARN = process.env.BEDROCK_PROFILE_ARN || '';
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || '';
const AWS_BEARER_TOKEN_BEDROCK = process.env.AWS_BEARER_TOKEN_BEDROCK || '';
const _CLAUDE_CODE_USE_BEDROCK = process.env.CLAUDE_CODE_USE_BEDROCK || '';

// IS_BEDROCK_MODE is true when any activation trigger is set.
// index.js also sets this to true when --bedrock CLI flag is found.
let IS_BEDROCK_MODE = !!(BEDROCK_REGION || _CLAUDE_CODE_USE_BEDROCK === '1' || _CLAUDE_CODE_USE_BEDROCK === 'true');

// Region resolution: BEDROCK_REGION → AWS_REGION → AWS_DEFAULT_REGION → us-east-1
const BEDROCK_RESOLVED_REGION = BEDROCK_REGION
  || process.env.AWS_REGION
  || process.env.AWS_DEFAULT_REGION
  || 'us-east-1';

// Bedrock activation source label (for startup log)
const BEDROCK_ACTIVATION_SOURCE = BEDROCK_REGION ? 'BEDROCK_REGION'
  : (_CLAUDE_CODE_USE_BEDROCK === '1' || _CLAUDE_CODE_USE_BEDROCK === 'true') ? 'CLAUDE_CODE_USE_BEDROCK'
  : '--bedrock flag';

// Optional: override Bedrock endpoint host/port for testing
const BEDROCK_TEST_HOST = process.env.BEDROCK_TEST_HOST || '';
const BEDROCK_TEST_PORT = parseInt(process.env.BEDROCK_TEST_PORT || '443', 10);
const BEDROCK_TEST_PROTOCOL = process.env.BEDROCK_TEST_PROTOCOL || 'https';

// Resolved credentials (set by index.js at startup in Bedrock mode)
let BEDROCK_CREDENTIALS = null;

// ── Anthropic → Bedrock model ID mapping table ───────────────────────
// Keys are Anthropic model ID prefixes, longest match wins.
const BEDROCK_MODEL_MAP = {
  // Claude 4 family
  'claude-opus-4-20250514':     'anthropic.claude-opus-4-20250514-v1:0',
  'claude-sonnet-4-20250514':   'anthropic.claude-sonnet-4-20250514-v1:0',
  'claude-haiku-4-20250514':    'anthropic.claude-haiku-4-20250514-v1:0',
  'claude-opus-4':              'anthropic.claude-opus-4-20250514-v1:0',
  'claude-sonnet-4':            'anthropic.claude-sonnet-4-20250514-v1:0',
  'claude-haiku-4':             'anthropic.claude-haiku-4-20250514-v1:0',
  // Claude 3.7
  'claude-3-7-sonnet-20250219': 'anthropic.claude-3-7-sonnet-20250219-v1:0',
  'claude-3-7-sonnet':          'anthropic.claude-3-7-sonnet-20250219-v1:0',
  // Claude 3.5
  'claude-3-5-sonnet-20241022': 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  'claude-3-5-sonnet-20240620': 'anthropic.claude-3-5-sonnet-20240620-v1:0',
  'claude-3-5-sonnet':          'anthropic.claude-3-5-sonnet-20241022-v2:0',
  'claude-3-5-haiku-20241022':  'anthropic.claude-3-5-haiku-20241022-v1:0',
  'claude-3-5-haiku':           'anthropic.claude-3-5-haiku-20241022-v1:0',
  // Claude 3
  'claude-3-opus-20240229':     'anthropic.claude-3-opus-20240229-v1:0',
  'claude-3-opus':              'anthropic.claude-3-opus-20240229-v1:0',
  'claude-3-sonnet-20240229':   'anthropic.claude-3-sonnet-20240229-v1:0',
  'claude-3-sonnet':            'anthropic.claude-3-sonnet-20240229-v1:0',
  'claude-3-haiku-20240307':    'anthropic.claude-3-haiku-20240307-v1:0',
  'claude-3-haiku':             'anthropic.claude-3-haiku-20240307-v1:0',
};

function resolveBedrockModelId(anthropicModelId) {
  if (anthropicModelId) {
    if (BEDROCK_MODEL_MAP[anthropicModelId]) return BEDROCK_MODEL_MAP[anthropicModelId];
    const keys = Object.keys(BEDROCK_MODEL_MAP).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      if (anthropicModelId.startsWith(key)) return BEDROCK_MODEL_MAP[key];
    }
  }
  if (BEDROCK_MODEL_ID) return BEDROCK_MODEL_ID;
  throw new Error(`No Bedrock model ID for '${anthropicModelId}'. Set BEDROCK_MODEL_ID to override.`);
}

function buildBedrockUrl(region, modelId, profileArn) {
  const segment = profileArn ? encodeURIComponent(profileArn) : encodeURIComponent(modelId);
  if (BEDROCK_TEST_HOST) {
    return `${BEDROCK_TEST_PROTOCOL}://${BEDROCK_TEST_HOST}:${BEDROCK_TEST_PORT}/model/${segment}/invoke-with-response-stream`;
  }
  return `https://bedrock-runtime.${region}.amazonaws.com/model/${segment}/invoke-with-response-stream`;
}

// Storage adapter (local by default, S3 via STORAGE_BACKEND=s3)
const storage = createStorage();

// Model → context window fallback mapping (used when LiteLLM data unavailable)
// https://docs.anthropic.com/en/docs/about-claude/models
const MODEL_CONTEXT_FALLBACK = {
  'claude-opus-4':     200_000,
  'claude-sonnet-4':   200_000,
  'claude-haiku-4':    200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku':  200_000,
  'claude-3-opus':     200_000,
  'claude-3-sonnet':   200_000,
  'claude-3-haiku':    200_000,
};
const DEFAULT_CONTEXT = 200_000;

// Extract effective model ID from system prompt (includes [1m] suffix if present).
// API request model field never includes [1m], but system prompt does:
//   "The exact model ID is claude-opus-4-6[1m]."
function extractModelFromSystem(system) {
  if (!Array.isArray(system)) return null;
  for (const block of system) {
    const text = typeof block === 'string' ? block : (block?.text || '');
    const m = text.match(/exact model ID is (claude-[^\s.]+)/);
    if (m) return m[1];
  }
  return null;
}

function getMaxContext(model, system) {
  // Prefer model ID from system prompt (has [1m] suffix when applicable)
  const effective = extractModelFromSystem(system) || model;
  if (!effective) return DEFAULT_CONTEXT;
  // 1) Explicit suffix: "claude-opus-4-6[1m]" → 1M
  if (/\[1m\]/i.test(effective)) return 1_000_000;
  // 2) Known Claude Code defaults (200K standard plan)
  const stripped = effective.replace(/\[.*\]/, '');
  const keys = Object.keys(MODEL_CONTEXT_FALLBACK).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (stripped.startsWith(key)) return MODEL_CONTEXT_FALLBACK[key];
  }
  // 3) LiteLLM dynamic data — only for unknown models not in fallback table
  const { getModelContext } = require('./pricing');
  const dynamic = getModelContext(stripped);
  if (dynamic) return dynamic;
  return DEFAULT_CONTEXT;
}

// Ensure logs dir exists; migrate from legacy location if needed
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  // One-time migration from old package-relative logs/
  const legacyIndex = path.join(LEGACY_LOGS_DIR, 'index.ndjson');
  if (fs.existsSync(legacyIndex)) {
    try {
      const files = fs.readdirSync(LEGACY_LOGS_DIR);
      for (const f of files) {
        fs.renameSync(path.join(LEGACY_LOGS_DIR, f), path.join(LOGS_DIR, f));
      }
      console.log(`Migrated logs from ${LEGACY_LOGS_DIR} → ${LOGS_DIR}`);
    } catch (e) {
      console.error(`Log migration failed: ${e.message}`);
    }
  }
}

module.exports = {
  PORT,
  ANTHROPIC_HOST,
  ANTHROPIC_PORT,
  ANTHROPIC_PROTOCOL,
  LOGS_DIR,
  RESTORE_DAYS,
  storage,
  MODEL_CONTEXT_FALLBACK,
  DEFAULT_CONTEXT,
  getMaxContext,
  // Bedrock
  get IS_BEDROCK_MODE() { return IS_BEDROCK_MODE; },
  set IS_BEDROCK_MODE(v) { IS_BEDROCK_MODE = v; },
  BEDROCK_REGION,
  BEDROCK_RESOLVED_REGION,
  BEDROCK_ACTIVATION_SOURCE,
  BEDROCK_PROFILE_ARN,
  BEDROCK_MODEL_ID,
  AWS_BEARER_TOKEN_BEDROCK,
  BEDROCK_TEST_HOST,
  BEDROCK_TEST_PORT,
  BEDROCK_TEST_PROTOCOL,
  get BEDROCK_CREDENTIALS() { return BEDROCK_CREDENTIALS; },
  set BEDROCK_CREDENTIALS(v) { BEDROCK_CREDENTIALS = v; },
  BEDROCK_MODEL_MAP,
  resolveBedrockModelId,
  buildBedrockUrl,
};
