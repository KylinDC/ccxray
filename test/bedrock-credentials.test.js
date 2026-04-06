'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');

const { resolveCredentials, parseCredentialsFile } = require('../server/bedrock-credentials');

// ── parseCredentialsFile unit tests ─────────────────────────────────

describe('parseCredentialsFile', () => {
  it('12.1 parses default profile credentials', () => {
    const text = `
[default]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
`;
    const result = parseCredentialsFile(text, 'default');
    assert.equal(result.accessKeyId, 'AKIAIOSFODNN7EXAMPLE');
    assert.equal(result.secretAccessKey, 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    assert.ok(!result.sessionToken, 'No session token in this profile');
  });

  it('12.2 includes sessionToken when aws_session_token is set', () => {
    const text = `
[default]
aws_access_key_id = KEYID
aws_secret_access_key = SECRET
aws_session_token = TOKEN123
`;
    const result = parseCredentialsFile(text, 'default');
    assert.equal(result.sessionToken, 'TOKEN123');
  });

  it('12.4 reads named profile when specified', () => {
    const text = `
[default]
aws_access_key_id = DEFAULT_KEY
aws_secret_access_key = DEFAULT_SECRET

[myprofile]
aws_access_key_id = PROFILE_KEY
aws_secret_access_key = PROFILE_SECRET
`;
    const result = parseCredentialsFile(text, 'myprofile');
    assert.equal(result.accessKeyId, 'PROFILE_KEY');
    assert.equal(result.secretAccessKey, 'PROFILE_SECRET');
  });

  it('returns null when profile not found', () => {
    const text = `
[default]
aws_access_key_id = KEY
aws_secret_access_key = SECRET
`;
    const result = parseCredentialsFile(text, 'nonexistent');
    assert.equal(result, null);
  });

  it('returns null when only access key but no secret', () => {
    const text = `
[default]
aws_access_key_id = KEY
`;
    const result = parseCredentialsFile(text, 'default');
    assert.equal(result, null);
  });
});

// ── resolveCredentials integration tests ─────────────────────────────

describe('resolveCredentials', () => {
  let savedEnv;
  before(() => {
    savedEnv = {
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
      AWS_PROFILE: process.env.AWS_PROFILE,
      AWS_SHARED_CREDENTIALS_FILE: process.env.AWS_SHARED_CREDENTIALS_FILE,
    };
    // Clear all AWS env vars for test isolation
    for (const k of Object.keys(savedEnv)) delete process.env[k];
  });

  after(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('12.1 returns env var credentials when AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI';
    const creds = await resolveCredentials();
    assert.equal(creds.accessKeyId, 'AKIAIOSFODNN7EXAMPLE');
    assert.equal(creds.secretAccessKey, 'wJalrXUtnFEMI');
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
  });

  it('12.2 includes sessionToken from AWS_SESSION_TOKEN', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'KEY';
    process.env.AWS_SECRET_ACCESS_KEY = 'SECRET';
    process.env.AWS_SESSION_TOKEN = 'TOKEN';
    const creds = await resolveCredentials();
    assert.equal(creds.sessionToken, 'TOKEN');
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
  });

  it('12.3 falls back to credentials file when env vars absent', async () => {
    const tmpFile = path.join(os.tmpdir(), `ccxray-test-creds-${Date.now()}.ini`);
    fs.writeFileSync(tmpFile, `
[default]
aws_access_key_id = FILE_KEY
aws_secret_access_key = FILE_SECRET
`);
    process.env.AWS_SHARED_CREDENTIALS_FILE = tmpFile;
    try {
      const creds = await resolveCredentials();
      assert.ok(creds, 'Should find credentials from file');
      assert.equal(creds.accessKeyId, 'FILE_KEY');
      assert.equal(creds.secretAccessKey, 'FILE_SECRET');
    } finally {
      delete process.env.AWS_SHARED_CREDENTIALS_FILE;
      fs.unlinkSync(tmpFile);
    }
  });

  it('12.4 reads named profile when AWS_PROFILE is set', async () => {
    const tmpFile = path.join(os.tmpdir(), `ccxray-test-creds-profile-${Date.now()}.ini`);
    fs.writeFileSync(tmpFile, `
[default]
aws_access_key_id = DEFAULT_KEY
aws_secret_access_key = DEFAULT_SECRET

[staging]
aws_access_key_id = STAGING_KEY
aws_secret_access_key = STAGING_SECRET
`);
    process.env.AWS_SHARED_CREDENTIALS_FILE = tmpFile;
    process.env.AWS_PROFILE = 'staging';
    try {
      const creds = await resolveCredentials();
      assert.ok(creds, 'Should find credentials from named profile');
      assert.equal(creds.accessKeyId, 'STAGING_KEY');
    } finally {
      delete process.env.AWS_SHARED_CREDENTIALS_FILE;
      delete process.env.AWS_PROFILE;
      fs.unlinkSync(tmpFile);
    }
  });

  it('12.5 returns null when no credentials and IMDS times out', async () => {
    // Point credentials file to non-existent path so file lookup fails
    process.env.AWS_SHARED_CREDENTIALS_FILE = '/nonexistent/path/credentials';
    // IMDS will time out on a port that refuses connections (port 1 is privileged)
    // The resolver will try 169.254.169.254 which won't respond in test environments
    const creds = await resolveCredentials();
    // In test env (no EC2 metadata available), should return null
    assert.equal(creds, null);
    delete process.env.AWS_SHARED_CREDENTIALS_FILE;
  });
});
