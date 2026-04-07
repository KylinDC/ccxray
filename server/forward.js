'use strict';

const https = require('https');
const http = require('http');
const config = require('./config');
const store = require('./store');
const { calculateCost } = require('./pricing');
const helpers = require('./helpers');
const { broadcast, broadcastSessionStatus } = require('./sse-broadcast');
const { EventStreamDecoder } = require('./eventstream');
const sigv4 = require('./sigv4');

// ── Strip injected proxy stats from conversation history ─────────────
const STATS_PATTERN = /\n\n---\n📊 Context: .+$/s;

function stripInjectedStats(parsedBody) {
  if (!parsedBody?.messages) return false;
  let modified = false;
  for (const msg of parsedBody.messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (let i = msg.content.length - 1; i >= 0; i--) {
      const block = msg.content[i];
      if (block.type !== 'text') continue;
      if (STATS_PATTERN.test(block.text)) {
        block.text = block.text.replace(STATS_PATTERN, '');
        if (!block.text) { msg.content.splice(i, 1); }
        modified = true;
      }
    }
  }
  return modified;
}

// ── Forward request to Bedrock ────────────────────────────────────────
function forwardBedrockRequest(ctx) {
  const { id, ts, startTime, parsedBody, rawBody, clientReq, clientRes, reqSessionId } = ctx;

  const statsStripped = stripInjectedStats(parsedBody);

  // Translate the Anthropic API body to Bedrock native format:
  //   - add anthropic_version (Bedrock requires it in the body; Claude Code sends it as a header)
  //   - strip `model` (encoded in the URL) and `stream` (indicated by the endpoint path)
  const baseBody = parsedBody || JSON.parse(rawBody.toString());
  const { model: _model, stream: _stream, ...bedrockFields } = baseBody;
  const bodyToSend = Buffer.from(JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    ...bedrockFields,
  }));

  // Resolve Bedrock model ID
  let bedrockModelId;
  try {
    bedrockModelId = config.resolveBedrockModelId(parsedBody?.model);
  } catch (err) {
    if (reqSessionId) {
      store.activeRequests[reqSessionId] = Math.max(0, (store.activeRequests[reqSessionId] || 1) - 1);
      broadcastSessionStatus(reqSessionId);
    }
    clientRes.writeHead(400, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: 'bedrock_model_unknown', message: err.message }));
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const errEvent = [{ type: 'error', error: 'bedrock_model_unknown', message: err.message }];
    const resWritePromise = config.storage.write(id, '_res.json', JSON.stringify(errEvent))
      .catch(e => console.error('Write res.json failed:', e.message));
    const entry = {
      id, ts, sessionId: reqSessionId, method: clientReq.method, url: clientReq.url,
      req: parsedBody, res: errEvent, elapsed, status: 400, isSSE: false,
      tokens: helpers.tokenizeRequest(parsedBody),
      usage: null, cost: null, maxContext: null,
      cwd: store.sessionMeta[reqSessionId]?.cwd || null,
      receivedAt: startTime, model: parsedBody?.model || null,
      msgCount: parsedBody?.messages?.length || 0, toolCount: parsedBody?.tools?.length || 0,
      stopReason: 'error', title: null,
      sysHash: ctx.sysHash || null, toolsHash: ctx.toolsHash || null,
    };
    entry._writePromise = Promise.all([ctx.reqWritePromise, resWritePromise].filter(Boolean));
    store.entries.push(entry);
    store.trimEntries();
    broadcast(entry);
    console.error(`\x1b[31m❌ BEDROCK MODEL UNKNOWN: ${err.message}\x1b[0m`);
    return;
  }

  const bedrockUrl = config.buildBedrockUrl(config.BEDROCK_RESOLVED_REGION, bedrockModelId, config.BEDROCK_PROFILE_ARN);
  const url = new URL(bedrockUrl);

  // Build translated headers: strip Anthropic-specific and auth headers
  const fwdHeaders = {};
  for (const [k, v] of Object.entries(ctx.fwdHeaders || {})) {
    const lk = k.toLowerCase();
    if (['x-api-key', 'anthropic-version', 'authorization', 'host', 'content-length'].includes(lk)) continue;
    fwdHeaders[k] = v;
  }
  fwdHeaders['content-type'] = 'application/json';
  fwdHeaders['accept'] = 'application/vnd.amazon.eventstream';
  fwdHeaders['host'] = url.hostname;

  // Auth: bearer token takes precedence over SigV4
  if (config.AWS_BEARER_TOKEN_BEDROCK) {
    fwdHeaders['authorization'] = `Bearer ${config.AWS_BEARER_TOKEN_BEDROCK}`;
  } else {
    const creds = config.BEDROCK_CREDENTIALS;
    const signed = sigv4.sign('POST', bedrockUrl, fwdHeaders, bodyToSend, creds, config.BEDROCK_RESOLVED_REGION, 'bedrock');
    fwdHeaders['authorization'] = signed.authorization;
    fwdHeaders['x-amz-date'] = signed['x-amz-date'];
    if (signed['x-amz-security-token']) fwdHeaders['x-amz-security-token'] = signed['x-amz-security-token'];
  }
  fwdHeaders['content-length'] = bodyToSend.length;

  const protocol = (config.BEDROCK_TEST_PROTOCOL === 'http') ? http : https;
  const proxyReq = protocol.request({
    hostname: config.BEDROCK_TEST_HOST || url.hostname,
    port: config.BEDROCK_TEST_HOST ? config.BEDROCK_TEST_PORT : (url.port || 443),
    path: url.pathname + (url.search || ''),
    method: 'POST',
    headers: fwdHeaders,
  }, (proxyRes) => {
    // Override Content-Type so Claude Code receives standard SSE
    const responseHeaders = { ...proxyRes.headers };
    responseHeaders['content-type'] = 'text/event-stream';
    delete responseHeaders['content-length'];
    clientRes.writeHead(proxyRes.statusCode, responseHeaders);

    if (proxyRes.statusCode === 200) {
      handleBedrockSSEResponse(ctx, proxyRes, clientRes, bedrockModelId);
    } else {
      handleNonSSEResponse(ctx, proxyRes, clientRes);
    }
  });

  proxyReq.on('error', (err) => {
    console.error(`\x1b[31m❌ BEDROCK PROXY ERROR: ${err.message}\x1b[0m`);
    if (reqSessionId) {
      store.activeRequests[reqSessionId] = Math.max(0, (store.activeRequests[reqSessionId] || 1) - 1);
      broadcastSessionStatus(reqSessionId);
    }
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
    }
    clientRes.end(JSON.stringify({ error: 'proxy_error', message: err.message }));

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const errEvent = [{ type: 'error', error: 'proxy_error', message: err.message }];
    const resWritePromise = config.storage.write(id, '_res.json', JSON.stringify(errEvent))
      .catch(e => console.error('Write res.json failed:', e.message));
    const entry = {
      id, ts, sessionId: reqSessionId, method: clientReq.method, url: clientReq.url,
      req: parsedBody, res: errEvent, elapsed, status: 502, isSSE: false,
      tokens: helpers.tokenizeRequest(parsedBody),
      usage: null, cost: null, maxContext: null,
      cwd: store.sessionMeta[reqSessionId]?.cwd || null,
      receivedAt: startTime, model: parsedBody?.model || null,
      msgCount: parsedBody?.messages?.length || 0, toolCount: parsedBody?.tools?.length || 0,
      stopReason: 'error', title: null,
      sysHash: ctx.sysHash || null, toolsHash: ctx.toolsHash || null,
    };
    entry._writePromise = Promise.all([ctx.reqWritePromise, resWritePromise].filter(Boolean));
    store.entries.push(entry);
    store.trimEntries();
    broadcast(entry);
  });

  proxyReq.end(bodyToSend);
}

function handleBedrockSSEResponse(ctx, proxyRes, clientRes, bedrockModelId) {
  const { id, startTime, parsedBody, reqSessionId } = ctx;
  const decoder = new EventStreamDecoder();
  const decodedEvents = [];
  let maxBlockIndex = -1;
  const heldEventStrs = [];
  const eventTimestamps = [];
  let eventSeqIdx = 0;
  let streamErrored = false;

  proxyRes.on('error', (err) => {
    console.error(`\x1b[31m❌ BEDROCK UPSTREAM STREAM ERROR: ${err.message}\x1b[0m`);
    if (reqSessionId) {
      store.activeRequests[reqSessionId] = Math.max(0, (store.activeRequests[reqSessionId] || 1) - 1);
      broadcastSessionStatus(reqSessionId);
    }
    if (!clientRes.writableEnded) clientRes.end();
  });

  proxyRes.on('data', chunk => {
    if (streamErrored) return;
    const results = decoder.push(chunk);

    for (const result of results) {
      if (result.error === 'crc_mismatch') {
        console.warn(`\x1b[33m⚠ BEDROCK STREAM: CRC32 mismatch, skipping frame\x1b[0m`);
        continue;
      }
      if (result.error === 'modelStreamErrorException') {
        console.error(`\x1b[31m❌ BEDROCK STREAM ERROR: ${result.message}\x1b[0m`);
        streamErrored = true;
        if (!clientRes.writableEnded) clientRes.end();
        return;
      }
      if (!result.event) continue;

      const evt = result.event;
      eventTimestamps.push({ seqIdx: eventSeqIdx++, ts: Date.now() });
      if (evt.index != null && evt.index > maxBlockIndex) maxBlockIndex = evt.index;

      const sseStr = `data: ${JSON.stringify(evt)}\n\n`;

      if (evt.type === 'message_delta' || evt.type === 'message_stop') {
        heldEventStrs.push(sseStr);
      } else {
        clientRes.write(sseStr);
      }
      decodedEvents.push(evt);
    }
  });

  proxyRes.on('end', () => {
    if (streamErrored) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const errEvent = [{ type: 'error', error: 'modelStreamErrorException' }];
      const resWritePromise = config.storage.write(id, '_res.json', JSON.stringify(errEvent))
        .catch(e => console.error('Write res.json failed:', e.message));
      if (reqSessionId) {
        store.activeRequests[reqSessionId] = Math.max(0, (store.activeRequests[reqSessionId] || 1) - 1);
        broadcastSessionStatus(reqSessionId);
      }
      const entry = {
        id, ts: ctx.ts, sessionId: reqSessionId, method: ctx.clientReq.method, url: ctx.clientReq.url,
        req: parsedBody, res: errEvent, elapsed, status: 500, isSSE: true,
        tokens: helpers.tokenizeRequest(parsedBody),
        usage: null, cost: null, maxContext: null,
        cwd: store.sessionMeta[reqSessionId]?.cwd || null,
        receivedAt: startTime, model: parsedBody?.model || null,
        msgCount: parsedBody?.messages?.length || 0, toolCount: parsedBody?.tools?.length || 0,
        stopReason: 'error', title: null,
        sysHash: ctx.sysHash || null, toolsHash: ctx.toolsHash || null,
      };
      entry._writePromise = Promise.all([ctx.reqWritePromise, resWritePromise].filter(Boolean));
      store.entries.push(entry);
      store.trimEntries();
      broadcast(entry);
      return;
    }

    if (ctx.skipEntry) {
      for (const held of heldEventStrs) clientRes.write(held);
      if (!clientRes.writableEnded) clientRes.end();
      return;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Attach timestamps (same pattern as handleSSEResponse)
    for (let i = 0; i < decodedEvents.length && i < eventTimestamps.length; i++) {
      decodedEvents[i]._ts = eventTimestamps[i].ts;
    }

    const resWritePromise = config.storage.write(id, '_res.json', JSON.stringify(decodedEvents))
      .catch(e => console.error('Write res.json failed:', e.message));

    const usage = helpers.extractUsage(decodedEvents);
    const stopReason = heldEventStrs.reduce((r, raw) => {
      const m = raw.match(/^data: (.+)$/m);
      if (m) try { const e = JSON.parse(m[1]); if (e.delta?.stop_reason) return e.delta.stop_reason; } catch {}
      return r;
    }, '');

    const totalCtx = helpers.totalContextTokens(usage);
    if (usage && totalCtx && stopReason !== 'tool_use') {
      const maxCtx = config.getMaxContext(parsedBody?.model, parsedBody?.system);
      const pct = (totalCtx / maxCtx * 100).toFixed(1);
      const newIdx = maxBlockIndex + 1;
      const costInfo = calculateCost(usage, parsedBody?.model);

      let text = '\n\n---\n📊 Context: ' + pct + '% (' + totalCtx.toLocaleString() + ' / ' + maxCtx.toLocaleString() + ')';
      text += ' | ' + totalCtx.toLocaleString() + ' in + ' + (usage.output_tokens || 0).toLocaleString() + ' out';
      if (usage.cache_read_input_tokens) {
        const hitRate = (usage.cache_read_input_tokens / totalCtx * 100).toFixed(0);
        text += ' | Cache ' + hitRate + '% hit';
      }
      if (costInfo?.cost != null) {
        text += ' | $' + costInfo.cost.toFixed(4);
      }
      if (pct >= 90) {
        text += '\n⚠️ Context ' + pct + '% — consider /clear';
      } else if (pct >= 70) {
        text += '\n⚡ Context ' + pct + '% — getting full';
      }

      const sseEvent = (eventType, data) => 'event: ' + eventType + '\ndata: ' + JSON.stringify(data) + '\n\n';
      clientRes.write(sseEvent('content_block_start', { type: 'content_block_start', index: newIdx, content_block: { type: 'text', text: '' } }));
      clientRes.write(sseEvent('content_block_delta', { type: 'content_block_delta', index: newIdx, delta: { type: 'text_delta', text: text } }));
      clientRes.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: newIdx }));
    }

    // Inject intercept modification summary
    if (ctx.bodyModified && ctx.originalBody) {
      const orig = ctx.originalBody;
      const mod = parsedBody;
      const diffs = [];
      if (orig.model !== mod.model) diffs.push('Model: ' + orig.model + ' → ' + mod.model);
      const origMsgLen = (orig.messages || []).length;
      const modMsgLen = (mod.messages || []).length;
      if (origMsgLen !== modMsgLen) diffs.push('Messages: ' + origMsgLen + ' → ' + modMsgLen);
      const msgEdits = (mod.messages || []).reduce((cnt, m, i) => {
        const o = (orig.messages || [])[i];
        if (!o) return cnt;
        const oStr = typeof o.content === 'string' ? o.content : JSON.stringify(o.content);
        const mStr = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return oStr !== mStr ? cnt + 1 : cnt;
      }, 0);
      if (msgEdits > 0) diffs.push(msgEdits + ' message(s) edited');
      if (diffs.length > 0) {
        const interceptIdx = maxBlockIndex + (usage && totalCtx && stopReason !== 'tool_use' ? 2 : 1);
        const iText = '\n\n---\n🔀 Request was modified by dashboard intercept:\n  ' + diffs.join('\n  ');
        const sseEvt = (eventType, data) => 'event: ' + eventType + '\ndata: ' + JSON.stringify(data) + '\n\n';
        clientRes.write(sseEvt('content_block_start', { type: 'content_block_start', index: interceptIdx, content_block: { type: 'text', text: '' } }));
        clientRes.write(sseEvt('content_block_delta', { type: 'content_block_delta', index: interceptIdx, delta: { type: 'text_delta', text: iText } }));
        clientRes.write(sseEvt('content_block_stop', { type: 'content_block_stop', index: interceptIdx }));
      }
    }

    for (const held of heldEventStrs) clientRes.write(held);
    if (!clientRes.writableEnded) clientRes.end();

    if (reqSessionId) {
      store.activeRequests[reqSessionId] = Math.max(0, (store.activeRequests[reqSessionId] || 1) - 1);
      broadcastSessionStatus(reqSessionId);
      if (store.sessionMeta[reqSessionId]) store.sessionMeta[reqSessionId].lastStopReason = stopReason || null;
    }

    const sessionId = reqSessionId;
    const costInfo = calculateCost(usage, parsedBody?.model);
    const maxContext = config.getMaxContext(parsedBody?.model, parsedBody?.system);
    const title = helpers.extractResponseTitle(decodedEvents);
    const thinkingDuration = helpers.computeThinkingDuration(decodedEvents);
    const entry = {
      id, ts: ctx.ts, sessionId, method: ctx.clientReq.method, url: ctx.clientReq.url,
      req: parsedBody, res: decodedEvents,
      elapsed, status: proxyRes.statusCode, isSSE: true,
      tokens: helpers.tokenizeRequest(parsedBody),
      usage, cost: costInfo,
      maxContext,
      cwd: store.sessionMeta[sessionId]?.cwd || null,
      receivedAt: startTime,
      thinkingDuration,
      duplicateToolCalls: helpers.extractDuplicateToolCalls(parsedBody?.messages),
      model: parsedBody?.model || null,
      msgCount: parsedBody?.messages?.length || 0,
      toolCount: parsedBody?.tools?.length || 0,
      toolCalls: helpers.extractToolCalls(parsedBody?.messages),
      isSubagent: !store.extractCwd(parsedBody),
      title,
      stopReason,
      sysHash: ctx.sysHash || null,
      toolsHash: ctx.toolsHash || null,
    };
    entry._writePromise = Promise.all([ctx.reqWritePromise, resWritePromise].filter(Boolean));
    store.entries.push(entry);
    store.trimEntries();
    broadcast(entry);

    const indexLine = JSON.stringify({
      id, ts: ctx.ts, sessionId,
      model: entry.model, msgCount: entry.msgCount, toolCount: entry.toolCount,
      toolCalls: entry.toolCalls, isSubagent: entry.isSubagent,
      cwd: entry.cwd, isSSE: true,
      usage, cost: costInfo, maxContext,
      stopReason, title, thinkingDuration,
      elapsed, status: proxyRes.statusCode,
      receivedAt: startTime,
      sysHash: ctx.sysHash || null, toolsHash: ctx.toolsHash || null,
    });
    config.storage.appendIndex(indexLine + '\n').catch(e => console.error('Write index failed:', e.message));

    entry.req = null;
    entry.res = null;
    entry._loaded = false;

    console.log(`\x1b[32m📥 BEDROCK RESPONSE [${helpers.taipeiTime()}]  (${elapsed}s)  status=${proxyRes.statusCode}\x1b[0m`);
    if (usage) helpers.printContextBar(usage, parsedBody?.model, parsedBody?.system);
    if (costInfo?.cost != null) {
      store.sessionCosts.set(sessionId, (store.sessionCosts.get(sessionId) || 0) + costInfo.cost);
      console.log(`  💰 $${costInfo.cost.toFixed(4)} this turn | $${store.sessionCosts.get(sessionId).toFixed(4)} session`);
    }
    helpers.printSeparator();
    console.log();
  });
}

// ── Forward request to Anthropic ─────────────────────────────────────
function forwardRequest(ctx) {
  // Route to Bedrock path when Bedrock mode is active
  if (config.IS_BEDROCK_MODE) return forwardBedrockRequest(ctx);

  const { id, ts, startTime, parsedBody, rawBody, clientReq, clientRes, fwdHeaders, reqSessionId } = ctx;

  // Remove previously injected stats so they don't accumulate in conversation
  const statsStripped = stripInjectedStats(parsedBody);
  const bodyToSend = (ctx.bodyModified || statsStripped) ? Buffer.from(JSON.stringify(parsedBody)) : rawBody;

  const transport = config.ANTHROPIC_PROTOCOL === 'http' ? http : https;
  const proxyReq = transport.request({
    hostname: config.ANTHROPIC_HOST, port: config.ANTHROPIC_PORT,
    path: clientReq.url, method: clientReq.method,
    headers: { ...fwdHeaders, 'content-length': bodyToSend.length },
  }, (proxyRes) => {
    const isSSE = (proxyRes.headers['content-type'] || '').includes('text/event-stream');

    // Capture rate limit headers
    const rl = proxyRes.headers;
    if (rl['anthropic-ratelimit-tokens-limit']) {
      store.setRateLimitState({
        tokensLimit:      parseInt(rl['anthropic-ratelimit-tokens-limit']) || null,
        tokensRemaining:  parseInt(rl['anthropic-ratelimit-tokens-remaining']) || null,
        tokensReset:      rl['anthropic-ratelimit-tokens-reset'] || null,
        inputLimit:       parseInt(rl['anthropic-ratelimit-input-tokens-limit']) || null,
        inputRemaining:   parseInt(rl['anthropic-ratelimit-input-tokens-remaining']) || null,
        inputReset:       rl['anthropic-ratelimit-input-tokens-reset'] || null,
        updatedAt:        Date.now(),
      });
    }
    clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);

    if (isSSE) {
      handleSSEResponse(ctx, proxyRes, clientRes);
    } else {
      handleNonSSEResponse(ctx, proxyRes, clientRes);
    }
  });

  proxyReq.on('error', (err) => {
    console.error(`\x1b[31m❌ PROXY ERROR: ${err.message}\x1b[0m`);
    if (reqSessionId) {
      store.activeRequests[reqSessionId] = Math.max(0, (store.activeRequests[reqSessionId] || 1) - 1);
      broadcastSessionStatus(reqSessionId);
    }
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
    }
    clientRes.end(JSON.stringify({ error: 'proxy_error', message: err.message }));
  });

  proxyReq.end(bodyToSend);
}

function handleSSEResponse(ctx, proxyRes, clientRes) {
  const { id, startTime, parsedBody, reqSessionId, fwdHeaders } = ctx;
  const resChunks = [];
  let sseLineBuf = '';
  let maxBlockIndex = -1;
  const heldEvents = [];
  const eventTimestamps = [];
  let eventSeqIdx = 0;

  proxyRes.on('error', (err) => {
    console.error(`\x1b[31m❌ UPSTREAM STREAM ERROR: ${err.message}\x1b[0m`);
    if (reqSessionId) {
      store.activeRequests[reqSessionId] = Math.max(0, (store.activeRequests[reqSessionId] || 1) - 1);
      broadcastSessionStatus(reqSessionId);
    }
    if (!clientRes.writableEnded) clientRes.end();
  });

  proxyRes.on('data', chunk => {
    resChunks.push(chunk);
    sseLineBuf += chunk.toString();

    const parts = sseLineBuf.split('\n\n');
    sseLineBuf = parts.pop();

    for (const part of parts) {
      if (!part.trim()) { clientRes.write('\n\n'); continue; }

      const dataMatch = part.match(/^data: (.+)$/m);
      if (dataMatch) {
        try {
          const evt = JSON.parse(dataMatch[1]);
          eventTimestamps.push({ seqIdx: eventSeqIdx++, ts: Date.now() });
          if (evt.index != null && evt.index > maxBlockIndex) maxBlockIndex = evt.index;
          if (evt.type === 'message_delta' || evt.type === 'message_stop') {
            heldEvents.push(part + '\n\n');
            continue;
          }
        } catch {}
      }

      clientRes.write(part + '\n\n');
    }
  });

  proxyRes.on('end', () => {
    if (sseLineBuf.trim()) {
      const dataMatch = sseLineBuf.match(/^data: (.+)$/m);
      let held = false;
      if (dataMatch) {
        try {
          const evt = JSON.parse(dataMatch[1]);
          eventTimestamps.push({ seqIdx: eventSeqIdx++, ts: Date.now() });
          if (evt.index != null && evt.index > maxBlockIndex) maxBlockIndex = evt.index;
          if (evt.type === 'message_delta' || evt.type === 'message_stop') {
            heldEvents.push(sseLineBuf + '\n\n');
            held = true;
          }
        } catch {}
      }
      if (!held) clientRes.write(sseLineBuf);
    }

    // Quota-check: just flush held events and end — no logging, no entry
    if (ctx.skipEntry) {
      for (const held of heldEvents) clientRes.write(held);
      clientRes.end();
      return;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const raw = Buffer.concat(resChunks).toString();
    const events = helpers.parseSSEEvents(raw);
    for (let i = 0; i < events.length && i < eventTimestamps.length; i++) {
      events[i]._ts = eventTimestamps[i].ts;
    }
    const resWritePromise = config.storage.write(id, '_res.json', JSON.stringify(events)).catch(e => console.error('Write res.json failed:', e.message));

    const usage = helpers.extractUsage(events);
    // Inject usage text block before message_delta/message_stop
    const stopReason = heldEvents.reduce((r, raw) => {
      const m = raw.match(/^data: (.+)$/m);
      if (m) try { const e = JSON.parse(m[1]); if (e.delta?.stop_reason) return e.delta.stop_reason; } catch {}
      return r;
    }, '');
    const totalCtx = helpers.totalContextTokens(usage);
    if (usage && totalCtx && stopReason !== 'tool_use') {
      const maxCtx = config.getMaxContext(parsedBody?.model, parsedBody?.system);
      const pct = (totalCtx / maxCtx * 100).toFixed(1);
      const newIdx = maxBlockIndex + 1;
      const costInfo = calculateCost(usage, parsedBody?.model);

      let text = '\n\n---\n📊 Context: ' + pct + '% (' + totalCtx.toLocaleString() + ' / ' + maxCtx.toLocaleString() + ')';
      text += ' | ' + totalCtx.toLocaleString() + ' in + ' + (usage.output_tokens || 0).toLocaleString() + ' out';
      if (usage.cache_read_input_tokens) {
        const hitRate = (usage.cache_read_input_tokens / totalCtx * 100).toFixed(0);
        text += ' | Cache ' + hitRate + '% hit';
      }
      if (costInfo?.cost != null) {
        text += ' | $' + costInfo.cost.toFixed(4);
      }
      if (pct >= 90) {
        text += '\n⚠️ Context ' + pct + '% — consider /clear';
      } else if (pct >= 70) {
        text += '\n⚡ Context ' + pct + '% — getting full';
      }

      const sseEvent = (eventType, data) => 'event: ' + eventType + '\ndata: ' + JSON.stringify(data) + '\n\n';
      clientRes.write(sseEvent('content_block_start', { type: 'content_block_start', index: newIdx, content_block: { type: 'text', text: '' } }));
      clientRes.write(sseEvent('content_block_delta', { type: 'content_block_delta', index: newIdx, delta: { type: 'text_delta', text: text } }));
      clientRes.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: newIdx }));
    }

    // Inject intercept modification summary
    if (ctx.bodyModified && ctx.originalBody) {
      const orig = ctx.originalBody;
      const mod = parsedBody;
      const diffs = [];
      if (orig.model !== mod.model) diffs.push('Model: ' + orig.model + ' → ' + mod.model);
      const origMsgLen = (orig.messages || []).length;
      const modMsgLen = (mod.messages || []).length;
      if (origMsgLen !== modMsgLen) diffs.push('Messages: ' + origMsgLen + ' → ' + modMsgLen);
      const msgEdits = (mod.messages || []).reduce((cnt, m, i) => {
        const o = (orig.messages || [])[i];
        if (!o) return cnt;
        const oStr = typeof o.content === 'string' ? o.content : JSON.stringify(o.content);
        const mStr = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return oStr !== mStr ? cnt + 1 : cnt;
      }, 0);
      if (msgEdits > 0) diffs.push(msgEdits + ' message(s) edited');
      const origToolLen = (orig.tools || []).length;
      const modToolLen = (mod.tools || []).length;
      if (origToolLen !== modToolLen) diffs.push('Tools: ' + origToolLen + ' → ' + modToolLen + ' (' + (modToolLen - origToolLen) + ')');
      const origSys = typeof orig.system === 'string' ? orig.system : JSON.stringify(orig.system);
      const modSys = typeof mod.system === 'string' ? mod.system : JSON.stringify(mod.system);
      if (origSys !== modSys) diffs.push('System prompt: modified');
      if (diffs.length > 0) {
        const interceptIdx = maxBlockIndex + (usage && totalCtx && stopReason !== 'tool_use' ? 2 : 1);
        const iText = '\n\n---\n🔀 Request was modified by dashboard intercept:\n  ' + diffs.join('\n  ');
        const sseEvt = (eventType, data) => 'event: ' + eventType + '\ndata: ' + JSON.stringify(data) + '\n\n';
        clientRes.write(sseEvt('content_block_start', { type: 'content_block_start', index: interceptIdx, content_block: { type: 'text', text: '' } }));
        clientRes.write(sseEvt('content_block_delta', { type: 'content_block_delta', index: interceptIdx, delta: { type: 'text_delta', text: iText } }));
        clientRes.write(sseEvt('content_block_stop', { type: 'content_block_stop', index: interceptIdx }));
      }
    }

    // Forward held events
    for (const held of heldEvents) {
      clientRes.write(held);
    }
    clientRes.end();

    if (reqSessionId) {
      store.activeRequests[reqSessionId] = Math.max(0, (store.activeRequests[reqSessionId] || 1) - 1);
      broadcastSessionStatus(reqSessionId);
      if (store.sessionMeta[reqSessionId]) store.sessionMeta[reqSessionId].lastStopReason = stopReason || null;
    }

    const sessionId = reqSessionId;
    const costInfo = calculateCost(usage, parsedBody?.model);
    const maxContext = config.getMaxContext(parsedBody?.model, parsedBody?.system);
    const title = helpers.extractResponseTitle(events);
    const thinkingDuration = helpers.computeThinkingDuration(events);
    const entry = {
      id, ts: ctx.ts, sessionId, method: ctx.clientReq.method, url: ctx.clientReq.url,
      req: parsedBody, res: events,
      elapsed, status: proxyRes.statusCode, isSSE: true,
      tokens: helpers.tokenizeRequest(parsedBody),
      usage, cost: costInfo,
      maxContext,
      cwd: store.sessionMeta[sessionId]?.cwd || null,
      receivedAt: startTime,
      thinkingDuration,
      duplicateToolCalls: helpers.extractDuplicateToolCalls(parsedBody?.messages),
      model: parsedBody?.model || null,
      msgCount: parsedBody?.messages?.length || 0,
      toolCount: parsedBody?.tools?.length || 0,
      toolCalls: helpers.extractToolCalls(parsedBody?.messages),
      isSubagent: !store.extractCwd(parsedBody),
      title,
      stopReason,
      sysHash: ctx.sysHash || null,
      toolsHash: ctx.toolsHash || null,
    };
    // Track in-flight writes so lazy-load can await them
    entry._writePromise = Promise.all([ctx.reqWritePromise, resWritePromise].filter(Boolean));
    store.entries.push(entry);
    store.trimEntries();
    broadcast(entry);

    // Persist to index (fire-and-forget after broadcast)
    const indexLine = JSON.stringify({
      id, ts: ctx.ts, sessionId,
      model: entry.model, msgCount: entry.msgCount, toolCount: entry.toolCount,
      toolCalls: entry.toolCalls, isSubagent: entry.isSubagent,
      cwd: entry.cwd, isSSE: true,
      usage, cost: costInfo, maxContext,
      stopReason, title, thinkingDuration,
      elapsed, status: proxyRes.statusCode,
      receivedAt: startTime,
      sysHash: ctx.sysHash || null, toolsHash: ctx.toolsHash || null,
    });
    config.storage.appendIndex(indexLine + '\n').catch(e => console.error('Write index failed:', e.message));

    // Release req/res from memory — data is on disk (or being written), lazy-load on demand
    entry.req = null;
    entry.res = null;
    entry._loaded = false;

    // Terminal summary
    console.log(`\x1b[32m📥 RESPONSE [${helpers.taipeiTime()}]  (${elapsed}s)  status=${proxyRes.statusCode}\x1b[0m`);
    if (usage) helpers.printContextBar(usage, parsedBody?.model, parsedBody?.system);
    if (costInfo?.cost != null) {
      store.sessionCosts.set(sessionId, (store.sessionCosts.get(sessionId) || 0) + costInfo.cost);
      console.log(`  💰 $${costInfo.cost.toFixed(4)} this turn | $${store.sessionCosts.get(sessionId).toFixed(4)} session`);
    }
    helpers.printSeparator();
    console.log();
  });
}

function handleNonSSEResponse(ctx, proxyRes, clientRes) {
  const { id, startTime, parsedBody, reqSessionId } = ctx;
  const resChunks = [];

  proxyRes.on('error', (err) => {
    console.error(`\x1b[31m❌ UPSTREAM STREAM ERROR: ${err.message}\x1b[0m`);
    if (reqSessionId) {
      store.activeRequests[reqSessionId] = Math.max(0, (store.activeRequests[reqSessionId] || 1) - 1);
      broadcastSessionStatus(reqSessionId);
    }
    if (!clientRes.writableEnded) clientRes.end();
  });

  proxyRes.on('data', chunk => {
    clientRes.write(chunk);
    resChunks.push(chunk);
  });

  proxyRes.on('end', () => {
    clientRes.end();

    // Quota-check: no logging, no entry
    if (ctx.skipEntry) return;

    if (reqSessionId) {
      store.activeRequests[reqSessionId] = Math.max(0, (store.activeRequests[reqSessionId] || 1) - 1);
      broadcastSessionStatus(reqSessionId);
      if (store.sessionMeta[reqSessionId]) store.sessionMeta[reqSessionId].lastStopReason = null;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const raw = Buffer.concat(resChunks).toString();
    let resData;
    try { resData = JSON.parse(raw); } catch { resData = raw; }
    const resWritePromise = config.storage.write(id, '_res.json', typeof resData === 'string' ? resData : JSON.stringify(resData)).catch(e => console.error('Write res.json failed:', e.message));

    const sessionId = reqSessionId;
    const maxContext = config.getMaxContext(parsedBody?.model, parsedBody?.system);
    const title = helpers.extractResponseTitle(resData);
    const stopReason = resData?.stop_reason || '';
    const entry = {
      id, ts: ctx.ts, sessionId, method: ctx.clientReq.method, url: ctx.clientReq.url,
      req: parsedBody, res: resData,
      elapsed, status: proxyRes.statusCode, isSSE: false,
      tokens: helpers.tokenizeRequest(parsedBody),
      usage: null, cost: null,
      maxContext,
      cwd: store.sessionMeta[sessionId]?.cwd || null,
      receivedAt: startTime,
      duplicateToolCalls: helpers.extractDuplicateToolCalls(parsedBody?.messages),
      model: parsedBody?.model || null,
      msgCount: parsedBody?.messages?.length || 0,
      toolCount: parsedBody?.tools?.length || 0,
      toolCalls: helpers.extractToolCalls(parsedBody?.messages),
      isSubagent: !store.extractCwd(parsedBody),
      title,
      stopReason,
      sysHash: ctx.sysHash || null,
      toolsHash: ctx.toolsHash || null,
    };
    entry._writePromise = Promise.all([ctx.reqWritePromise, resWritePromise].filter(Boolean));
    store.entries.push(entry);
    store.trimEntries();
    broadcast(entry);

    const indexLine = JSON.stringify({
      id, ts: ctx.ts, sessionId,
      model: entry.model, msgCount: entry.msgCount, toolCount: entry.toolCount,
      toolCalls: entry.toolCalls, isSubagent: entry.isSubagent,
      cwd: entry.cwd, isSSE: false,
      usage: null, cost: null, maxContext,
      stopReason, title, thinkingDuration: null,
      elapsed, status: proxyRes.statusCode,
      receivedAt: startTime,
      sysHash: ctx.sysHash || null, toolsHash: ctx.toolsHash || null,
    });
    config.storage.appendIndex(indexLine + '\n').catch(e => console.error('Write index failed:', e.message));

    // Release req/res from memory — data is on disk (or being written), lazy-load on demand
    entry.req = null;
    entry.res = null;
    entry._loaded = false;

    console.log(`\x1b[32m📥 RESPONSE [${helpers.taipeiTime()}]  (${elapsed}s)  status=${proxyRes.statusCode}\x1b[0m`);
    helpers.printSeparator();
    console.log();
  });
}

module.exports = { forwardRequest, forwardBedrockRequest };
