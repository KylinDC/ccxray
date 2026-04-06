'use strict';

const crypto = require('crypto');

function hmac(key, data, enc) {
  return crypto.createHmac('sha256', key).update(data).digest(enc || undefined);
}

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Sign a request with AWS Signature Version 4.
// Returns extra headers to add: { authorization, 'x-amz-date', ['x-amz-security-token'] }
//
// Parameters:
//   method      - HTTP method (e.g. 'POST')
//   urlStr      - Full URL string (e.g. 'https://bedrock-runtime.us-east-1.amazonaws.com/model/...')
//   headers     - Headers object to be forwarded (host/x-amz-date will be added from here for signing)
//   body        - Request body (Buffer or string)
//   credentials - { accessKeyId, secretAccessKey, sessionToken }
//   region      - AWS region (e.g. 'us-east-1')
//   service     - AWS service name (e.g. 'bedrock')
function sign(method, urlStr, headers, body, credentials, region, service) {
  const url = new URL(urlStr);

  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);

  // Build the set of headers to sign (lowercase names)
  const signingHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    // Exclude pseudo-headers that we're replacing
    if (lk === 'authorization' || lk === 'x-amz-date' || lk === 'x-amz-security-token') continue;
    signingHeaders[lk] = String(v).trim();
  }
  signingHeaders['host'] = url.hostname;
  signingHeaders['x-amz-date'] = amzDate;
  if (credentials.sessionToken) {
    signingHeaders['x-amz-security-token'] = credentials.sessionToken;
  }

  // Sorted unique lowercase header keys
  const sortedKeys = [...new Set(Object.keys(signingHeaders).sort())];
  const canonicalHeaders = sortedKeys.map(k => `${k}:${signingHeaders[k]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');

  // Canonical URI: percent-encode each path segment (unreserved chars stay as-is)
  const canonicalUri = url.pathname
    .split('/')
    .map(seg => encodeURIComponent(decodeURIComponent(seg)))
    .join('/') || '/';

  // Canonical query string: sorted key=value pairs
  const queryEntries = [...url.searchParams.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const canonicalQueryString = queryEntries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const payloadHash = sha256hex(body || '');

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256hex(canonicalRequest),
  ].join('\n');

  // Derive signing key: HMAC chain AWS4+secret → date → region → service → 'aws4_request'
  const signingKey = hmac(
    hmac(
      hmac(
        hmac(`AWS4${credentials.secretAccessKey}`, dateStamp),
        region
      ),
      service
    ),
    'aws4_request'
  );

  const signature = hmac(signingKey, stringToSign, 'hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    authorization,
    'x-amz-date': amzDate,
    ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}),
  };
}

module.exports = { sign };
