'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

// Resolve AWS credentials for Bedrock. Returns { accessKeyId, secretAccessKey, sessionToken } or null.
// Resolution order:
//   1. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY env vars
//   2. ~/.aws/credentials profile (AWS_PROFILE or 'default')
//   3. EC2/ECS IMDSv2 (1s timeout)
async function resolveCredentials() {
  // 1. Env vars
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN || null,
    };
  }

  // 2. ~/.aws/credentials file
  const profile = process.env.AWS_PROFILE || 'default';
  const credFile = process.env.AWS_SHARED_CREDENTIALS_FILE
    || path.join(os.homedir(), '.aws', 'credentials');
  try {
    const text = fs.readFileSync(credFile, 'utf8');
    const creds = parseCredentialsFile(text, profile);
    if (creds) return creds;
  } catch {}

  // 3. IMDSv2 (EC2/ECS instance metadata)
  try {
    const creds = await fetchImdsCredentials();
    if (creds) return creds;
  } catch {}

  return null;
}

function parseCredentialsFile(text, profile) {
  const lines = text.split('\n');
  let inProfile = false;
  const result = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inProfile = line === `[${profile}]`;
      continue;
    }
    if (!inProfile || !line || line.startsWith('#') || line.startsWith(';')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).trim();
    if (key === 'aws_access_key_id') result.accessKeyId = val;
    if (key === 'aws_secret_access_key') result.secretAccessKey = val;
    if (key === 'aws_session_token') result.sessionToken = val;
  }
  return (result.accessKeyId && result.secretAccessKey) ? result : null;
}

function fetchImdsCredentials() {
  return new Promise((resolve) => {
    const TIMEOUT = 1000;
    const IMDS_HOST = process.env.CCXRAY_IMDS_HOST || '169.254.169.254';

    function fail() { resolve(null); }

    // Step 1: Get IMDSv2 token
    const tokenReq = http.request({
      hostname: IMDS_HOST,
      path: '/latest/api/token',
      method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' },
    }, (res) => {
      let token = '';
      res.on('data', c => { token += c; });
      res.on('end', () => {
        try {
          // Strip non-printable / non-ASCII chars — non-EC2 IMDS endpoints
          // (e.g. Azure link-local) may return HTML that causes ERR_INVALID_CHAR.
          token = token.trim().replace(/[^\x20-\x7E]/g, '');
          if (!token) return fail();

          // Step 2: Get IAM role name
          const roleReq = http.request({
            hostname: IMDS_HOST,
            path: '/latest/meta-data/iam/security-credentials/',
            method: 'GET',
            headers: { 'X-aws-ec2-metadata-token': token },
          }, (res2) => {
            let roleName = '';
            res2.on('data', c => { roleName += c; });
            res2.on('end', () => {
              roleName = roleName.trim().split('\n')[0].trim();
              if (!roleName) return fail();

              // Step 3: Get credentials for the role
              const credsReq = http.request({
                hostname: IMDS_HOST,
                path: `/latest/meta-data/iam/security-credentials/${roleName}`,
                method: 'GET',
                headers: { 'X-aws-ec2-metadata-token': token },
              }, (res3) => {
                let body = '';
                res3.on('data', c => { body += c; });
                res3.on('end', () => {
                  try {
                    const data = JSON.parse(body);
                    if (data.AccessKeyId && data.SecretAccessKey) {
                      resolve({
                        accessKeyId: data.AccessKeyId,
                        secretAccessKey: data.SecretAccessKey,
                        sessionToken: data.Token || null,
                      });
                    } else {
                      fail();
                    }
                  } catch { fail(); }
                });
              });
              credsReq.setTimeout(TIMEOUT, () => { credsReq.destroy(); fail(); });
              credsReq.on('error', fail);
              credsReq.end();
            });
          });
          roleReq.setTimeout(TIMEOUT, () => { roleReq.destroy(); fail(); });
          roleReq.on('error', fail);
          roleReq.end();
        } catch { fail(); }
      });
    });
    tokenReq.setTimeout(TIMEOUT, () => { tokenReq.destroy(); fail(); });
    tokenReq.on('error', fail);
    tokenReq.end();
  });
}

module.exports = { resolveCredentials, parseCredentialsFile };
