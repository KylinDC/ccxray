'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// ── Helpers to load config with overridden env vars ──────────────────
// config.js reads env vars at require time, so we need to clear module cache.

function loadConfig(envOverrides = {}) {
  // Save and override env
  const saved = {};
  const keys = [
    'BEDROCK_REGION', 'BEDROCK_PROFILE_ARN', 'BEDROCK_MODEL_ID', 'AWS_BEARER_TOKEN_BEDROCK',
    'CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION', 'AWS_DEFAULT_REGION',
    'BEDROCK_TEST_HOST', 'BEDROCK_TEST_PORT', 'BEDROCK_TEST_PROTOCOL',
  ];
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(envOverrides)) {
    process.env[k] = v;
  }

  // Clear module cache to get fresh config
  delete require.cache[require.resolve('../server/config')];
  const config = require('../server/config');

  // Restore env
  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }

  return config;
}

describe('bedrock-config', () => {
  describe('IS_BEDROCK_MODE activation', () => {
    it('11.1 IS_BEDROCK_MODE is true when BEDROCK_REGION is set', () => {
      const c = loadConfig({ BEDROCK_REGION: 'us-east-1' });
      assert.equal(c.IS_BEDROCK_MODE, true);
    });

    it('11.2 IS_BEDROCK_MODE is true when CLAUDE_CODE_USE_BEDROCK=1', () => {
      const c = loadConfig({ CLAUDE_CODE_USE_BEDROCK: '1' });
      assert.equal(c.IS_BEDROCK_MODE, true);
    });

    it('11.3 IS_BEDROCK_MODE is true when CLAUDE_CODE_USE_BEDROCK=true', () => {
      const c = loadConfig({ CLAUDE_CODE_USE_BEDROCK: 'true' });
      assert.equal(c.IS_BEDROCK_MODE, true);
    });

    it('11.4 IS_BEDROCK_MODE is false when no env trigger is set', () => {
      const c = loadConfig({});
      assert.equal(c.IS_BEDROCK_MODE, false);
    });

    it('IS_BEDROCK_MODE is false when CLAUDE_CODE_USE_BEDROCK=0', () => {
      const c = loadConfig({ CLAUDE_CODE_USE_BEDROCK: '0' });
      assert.equal(c.IS_BEDROCK_MODE, false);
    });
  });

  describe('Region resolution', () => {
    it('11.5 BEDROCK_REGION wins over AWS_REGION and AWS_DEFAULT_REGION', () => {
      const c = loadConfig({ BEDROCK_REGION: 'ap-southeast-1', AWS_REGION: 'eu-west-1', AWS_DEFAULT_REGION: 'us-west-2' });
      assert.equal(c.BEDROCK_RESOLVED_REGION, 'ap-southeast-1');
    });

    it('11.6 AWS_REGION used when BEDROCK_REGION is not set', () => {
      const c = loadConfig({ AWS_REGION: 'eu-west-1', CLAUDE_CODE_USE_BEDROCK: '1' });
      assert.equal(c.BEDROCK_RESOLVED_REGION, 'eu-west-1');
    });

    it('AWS_DEFAULT_REGION used when neither BEDROCK_REGION nor AWS_REGION is set', () => {
      const c = loadConfig({ AWS_DEFAULT_REGION: 'us-west-2', CLAUDE_CODE_USE_BEDROCK: '1' });
      assert.equal(c.BEDROCK_RESOLVED_REGION, 'us-west-2');
    });

    it('defaults to us-east-1 when no region env var is set', () => {
      const c = loadConfig({ CLAUDE_CODE_USE_BEDROCK: '1' });
      assert.equal(c.BEDROCK_RESOLVED_REGION, 'us-east-1');
    });
  });

  describe('resolveBedrockModelId', () => {
    it('11.7 exact match returns correct Bedrock ID', () => {
      const c = loadConfig({ BEDROCK_REGION: 'us-east-1' });
      assert.equal(
        c.resolveBedrockModelId('claude-3-5-sonnet-20241022'),
        'anthropic.claude-3-5-sonnet-20241022-v2:0'
      );
    });

    it('11.8 prefix match resolves versioned model', () => {
      const c = loadConfig({ BEDROCK_REGION: 'us-east-1' });
      const result = c.resolveBedrockModelId('claude-3-opus-20240229');
      assert.equal(result, 'anthropic.claude-3-opus-20240229-v1:0');
    });

    it('11.8b prefix match for short model ID', () => {
      const c = loadConfig({ BEDROCK_REGION: 'us-east-1' });
      assert.equal(
        c.resolveBedrockModelId('claude-3-haiku-20240307'),
        'anthropic.claude-3-haiku-20240307-v1:0'
      );
    });

    it('11.9 BEDROCK_MODEL_ID override used for unknown model', () => {
      const c = loadConfig({ BEDROCK_REGION: 'us-east-1', BEDROCK_MODEL_ID: 'anthropic.claude-future-v99:0' });
      const result = c.resolveBedrockModelId('claude-future-99');
      assert.equal(result, 'anthropic.claude-future-v99:0');
    });

    it('11.10 unknown model without override throws with model name in message', () => {
      const c = loadConfig({ BEDROCK_REGION: 'us-east-1' });
      assert.throws(
        () => c.resolveBedrockModelId('claude-xyz-unknown-9999'),
        (err) => {
          assert.ok(err.message.includes('claude-xyz-unknown-9999'), 'Error should mention model name');
          assert.ok(err.message.includes('BEDROCK_MODEL_ID'), 'Error should mention override env var');
          return true;
        }
      );
    });

    it('maps Claude 4 family correctly', () => {
      const c = loadConfig({ BEDROCK_REGION: 'us-east-1' });
      assert.equal(c.resolveBedrockModelId('claude-opus-4-20250514'), 'anthropic.claude-opus-4-20250514-v1:0');
      assert.equal(c.resolveBedrockModelId('claude-sonnet-4'), 'anthropic.claude-sonnet-4-20250514-v1:0');
    });
  });

  describe('buildBedrockUrl', () => {
    it('11.11 standard model ID produces correct URL', () => {
      const c = loadConfig({ BEDROCK_REGION: 'us-east-1' });
      const url = c.buildBedrockUrl('us-east-1', 'anthropic.claude-3-5-sonnet-20241022-v2:0', '');
      assert.equal(url, 'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/invoke-with-response-stream');
    });

    it('11.12 BEDROCK_PROFILE_ARN URL-encodes the ARN', () => {
      const c = loadConfig({ BEDROCK_REGION: 'us-east-1' });
      const arn = 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0';
      const url = c.buildBedrockUrl('us-east-1', 'ignored', arn);
      assert.ok(url.includes('/model/'), 'URL should have /model/ segment');
      assert.ok(!url.includes('arn:aws:bedrock:'), 'ARN should be URL-encoded');
      assert.ok(url.includes(encodeURIComponent(arn)), 'ARN should be percent-encoded');
    });

    it('uses BEDROCK_TEST_HOST when set', () => {
      const c = loadConfig({ BEDROCK_REGION: 'us-east-1', BEDROCK_TEST_HOST: 'localhost', BEDROCK_TEST_PORT: '9876', BEDROCK_TEST_PROTOCOL: 'http' });
      const url = c.buildBedrockUrl('us-east-1', 'anthropic.claude-3-5-sonnet-20241022-v2:0', '');
      assert.ok(url.startsWith('http://localhost:9876/'), 'Should use test host');
    });
  });
});
