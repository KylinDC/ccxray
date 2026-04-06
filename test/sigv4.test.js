'use strict';

// AWS SigV4 test suite reference vectors:
// https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
//
// We use the official AWS test suite payload from:
// https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html
//
// Test credentials (from AWS docs):
//   AccessKeyId:     AKIDEXAMPLE
//   SecretAccessKey: wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY
//   Region:          us-east-1
//   Service:         iam

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { sign } = require('../server/sigv4');

// ── Helpers to replicate AWS test vector exactly ─────────────────────

// AWS SigV4 test suite uses a fixed date: 20150830T123600Z
// We can't inject a date into sign(), so we verify structure and known outputs
// using a wrapper that overrides Date.

function signWithFixedDate(method, urlStr, headers, body, credentials, region, service, fixedDate) {
  // Temporarily override Date to return fixed timestamp
  const OrigDate = global.Date;
  class FakeDate extends OrigDate {
    constructor(...args) {
      if (args.length === 0) return new OrigDate(fixedDate);
      super(...args);
    }
    toISOString() {
      if (this.getTime() === new OrigDate(fixedDate).getTime()) return fixedDate;
      return super.toISOString();
    }
  }
  // Override new Date() and Date.now()
  global.Date = FakeDate;
  FakeDate.now = () => new OrigDate(fixedDate).getTime();
  FakeDate.parse = OrigDate.parse;
  FakeDate.UTC = OrigDate.UTC;
  try {
    return sign(method, urlStr, headers, body, credentials, region, service);
  } finally {
    global.Date = OrigDate;
  }
}

const AWS_TEST_CREDS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  sessionToken: null,
};
const FIXED_DATE = '2015-08-30T12:36:00.000Z'; // → 20150830T123600Z
const REGION = 'us-east-1';
const SERVICE = 'iam';

describe('sigv4', () => {
  describe('canonical request and signature format', () => {
    it('produces Authorization header in correct AWS4-HMAC-SHA256 format', () => {
      const result = signWithFixedDate(
        'GET',
        'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
        { host: 'iam.amazonaws.com' },
        '',
        AWS_TEST_CREDS,
        REGION,
        SERVICE,
        FIXED_DATE
      );

      assert.ok(result.authorization, 'Should return authorization header');
      assert.ok(result.authorization.startsWith('AWS4-HMAC-SHA256 '), 'Should start with AWS4-HMAC-SHA256');
      assert.ok(result.authorization.includes('Credential=AKIDEXAMPLE/'), 'Should contain Credential');
      assert.ok(result.authorization.includes('20150830/us-east-1/iam/aws4_request'), 'Should contain correct credential scope');
      assert.ok(result.authorization.includes('SignedHeaders='), 'Should contain SignedHeaders');
      assert.ok(result.authorization.includes('Signature='), 'Should contain Signature');
    });

    it('x-amz-date matches the fixed date', () => {
      const result = signWithFixedDate(
        'GET',
        'https://iam.amazonaws.com/',
        {},
        '',
        AWS_TEST_CREDS,
        REGION,
        SERVICE,
        FIXED_DATE
      );
      assert.equal(result['x-amz-date'], '20150830T123600Z');
    });

    it('signed headers include host and x-amz-date', () => {
      const result = signWithFixedDate(
        'POST',
        'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke-with-response-stream',
        { 'content-type': 'application/json', 'accept': 'application/vnd.amazon.eventstream' },
        '{"model":"claude-3-5-sonnet-20241022","messages":[]}',
        AWS_TEST_CREDS,
        'us-east-1',
        'bedrock',
        FIXED_DATE
      );

      const signedHeaders = result.authorization.match(/SignedHeaders=([^,]+)/)?.[1] || '';
      assert.ok(signedHeaders.includes('host'), 'SignedHeaders should include host');
      assert.ok(signedHeaders.includes('x-amz-date'), 'SignedHeaders should include x-amz-date');
    });

    it('signature is a 64-char hex string', () => {
      const result = signWithFixedDate(
        'POST',
        'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-haiku-20240307-v1:0/invoke-with-response-stream',
        { 'content-type': 'application/json' },
        '{}',
        AWS_TEST_CREDS,
        'us-east-1',
        'bedrock',
        FIXED_DATE
      );

      const sig = result.authorization.match(/Signature=([0-9a-f]+)/)?.[1];
      assert.ok(sig, 'Should have a signature');
      assert.equal(sig.length, 64, 'Signature should be 64 hex chars (sha256)');
      assert.ok(/^[0-9a-f]+$/.test(sig), 'Signature should be lowercase hex');
    });

    it('same inputs produce the same signature (deterministic)', () => {
      const args = [
        'POST',
        'https://bedrock-runtime.us-east-1.amazonaws.com/model/test/invoke-with-response-stream',
        { 'content-type': 'application/json' },
        '{"hello":"world"}',
        AWS_TEST_CREDS,
        'us-east-1',
        'bedrock',
        FIXED_DATE,
      ];
      const r1 = signWithFixedDate(...args);
      const r2 = signWithFixedDate(...args);
      assert.equal(r1.authorization, r2.authorization);
    });
  });

  describe('session token handling', () => {
    it('includes x-amz-security-token when sessionToken is set', () => {
      const creds = { ...AWS_TEST_CREDS, sessionToken: 'AQoDYXdzEJr//' };
      const result = signWithFixedDate(
        'POST',
        'https://bedrock-runtime.us-east-1.amazonaws.com/model/test/invoke-with-response-stream',
        {},
        '',
        creds,
        'us-east-1',
        'bedrock',
        FIXED_DATE
      );
      assert.equal(result['x-amz-security-token'], 'AQoDYXdzEJr//');
      // Session token must be in SignedHeaders
      const signedHeaders = result.authorization.match(/SignedHeaders=([^,]+)/)?.[1] || '';
      assert.ok(signedHeaders.includes('x-amz-security-token'), 'x-amz-security-token should be in SignedHeaders');
    });

    it('does not include x-amz-security-token when sessionToken is null', () => {
      const creds = { ...AWS_TEST_CREDS, sessionToken: null };
      const result = signWithFixedDate(
        'POST',
        'https://bedrock-runtime.us-east-1.amazonaws.com/model/test/invoke-with-response-stream',
        {},
        '',
        creds,
        'us-east-1',
        'bedrock',
        FIXED_DATE
      );
      assert.ok(!result['x-amz-security-token'], 'Should not have x-amz-security-token header');
      const signedHeaders = result.authorization.match(/SignedHeaders=([^,]+)/)?.[1] || '';
      assert.ok(!signedHeaders.includes('x-amz-security-token'), 'x-amz-security-token should not be in SignedHeaders');
    });
  });
});
