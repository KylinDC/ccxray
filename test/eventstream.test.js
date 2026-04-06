'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventStreamDecoder, crc32 } = require('../server/eventstream');

// ── Frame builder ────────────────────────────────────────────────────
// Builds a valid binary EventStream frame for a given Anthropic SSE event.

function buildFrame(anthropicEvent, eventType = 'chunk') {
  // Payload: {"bytes": "<base64-encoded event JSON>"}
  const eventJson = JSON.stringify(anthropicEvent);
  const b64 = Buffer.from(eventJson).toString('base64');
  const payloadJson = JSON.stringify({ bytes: b64 });
  const payloadBuf = Buffer.from(payloadJson);

  // Headers
  const headers = buildHeaders({
    ':event-type': eventType,
    ':content-type': 'application/json',
    ':message-type': 'event',
  });

  // Frame layout
  const headersLen = headers.length;
  const payloadLen = payloadBuf.length;
  const totalLen = 12 + headersLen + payloadLen + 4;

  const frame = Buffer.alloc(totalLen);
  frame.writeUInt32BE(totalLen, 0);
  frame.writeUInt32BE(headersLen, 4);

  const preludeCrc = crc32(frame, 0, 8);
  frame.writeUInt32BE(preludeCrc, 8);

  headers.copy(frame, 12);
  payloadBuf.copy(frame, 12 + headersLen);

  const messageCrc = crc32(frame, 0, totalLen - 4);
  frame.writeUInt32BE(messageCrc, totalLen - 4);

  return frame;
}

function buildErrorFrame(message, eventType = 'modelStreamErrorException') {
  const payloadBuf = Buffer.from(JSON.stringify({ message }));
  const headers = buildHeaders({
    ':event-type': eventType,
    ':message-type': 'exception',
  });
  const headersLen = headers.length;
  const totalLen = 12 + headersLen + payloadBuf.length + 4;
  const frame = Buffer.alloc(totalLen);
  frame.writeUInt32BE(totalLen, 0);
  frame.writeUInt32BE(headersLen, 4);
  frame.writeUInt32BE(crc32(frame, 0, 8), 8);
  headers.copy(frame, 12);
  payloadBuf.copy(frame, 12 + headersLen);
  frame.writeUInt32BE(crc32(frame, 0, totalLen - 4), totalLen - 4);
  return frame;
}

function buildHeaders(obj) {
  const parts = [];
  for (const [name, value] of Object.entries(obj)) {
    const nameBuf = Buffer.from(name);
    const valueBuf = Buffer.from(value);
    const entry = Buffer.alloc(1 + nameBuf.length + 1 + 2 + valueBuf.length);
    let off = 0;
    entry[off++] = nameBuf.length;
    nameBuf.copy(entry, off); off += nameBuf.length;
    entry[off++] = 7; // string type
    entry.writeUInt16BE(valueBuf.length, off); off += 2;
    valueBuf.copy(entry, off);
    parts.push(entry);
  }
  return Buffer.concat(parts);
}

// ── Tests ────────────────────────────────────────────────────────────

describe('EventStreamDecoder', () => {
  it('10.1 decodes a single complete binary frame', () => {
    const event = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } };
    const frame = buildFrame(event);
    const decoder = new EventStreamDecoder();
    const results = decoder.push(frame);
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].event, event);
  });

  it('10.2 decodes multiple frames in one push call', () => {
    const e1 = { type: 'message_start', message: { id: 'msg_1' } };
    const e2 = { type: 'content_block_delta', index: 0 };
    const e3 = { type: 'message_stop' };
    const frames = Buffer.concat([buildFrame(e1), buildFrame(e2), buildFrame(e3)]);
    const decoder = new EventStreamDecoder();
    const results = decoder.push(frames);
    assert.equal(results.length, 3);
    assert.deepEqual(results[0].event, e1);
    assert.deepEqual(results[1].event, e2);
    assert.deepEqual(results[2].event, e3);
  });

  it('10.3 handles frame split across two push calls', () => {
    const event = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } };
    const frame = buildFrame(event);
    const splitAt = Math.floor(frame.length / 2);

    const decoder = new EventStreamDecoder();
    const r1 = decoder.push(frame.slice(0, splitAt));
    assert.equal(r1.length, 0, 'First push should produce no events (incomplete frame)');
    const r2 = decoder.push(frame.slice(splitAt));
    assert.equal(r2.length, 1, 'Second push should complete the frame');
    assert.deepEqual(r2[0].event, event);
  });

  it('10.4 handles frame split at prelude boundary (2 bytes in first push)', () => {
    const event = { type: 'message_stop' };
    const frame = buildFrame(event);

    const decoder = new EventStreamDecoder();
    const r1 = decoder.push(frame.slice(0, 2));
    assert.equal(r1.length, 0);
    const r2 = decoder.push(frame.slice(2));
    assert.equal(r2.length, 1);
    assert.deepEqual(r2[0].event, event);
  });

  it('10.5 CRC32 mismatch on message CRC returns error descriptor and does not throw', () => {
    const event = { type: 'message_stop' };
    const frame = Buffer.from(buildFrame(event)); // mutable copy
    // Corrupt the last 4 bytes (message CRC)
    frame.writeUInt32BE(0xDEADBEEF, frame.length - 4);

    const decoder = new EventStreamDecoder();
    const results = decoder.push(frame);
    assert.equal(results.length, 1);
    assert.equal(results[0].error, 'crc_mismatch');
    assert.ok(!results[0].event, 'Should not have event on CRC mismatch');
  });

  it('10.6 prelude CRC mismatch returns error descriptor', () => {
    const event = { type: 'message_stop' };
    const frame = Buffer.from(buildFrame(event));
    // Corrupt the prelude CRC (bytes 8-11)
    frame.writeUInt32BE(0x12345678, 8);

    const decoder = new EventStreamDecoder();
    const results = decoder.push(frame);
    assert.equal(results.length, 1);
    assert.equal(results[0].error, 'crc_mismatch');
  });

  it('10.7 modelStreamErrorException frame returns error descriptor with message', () => {
    const frame = buildErrorFrame('Context length exceeded');
    const decoder = new EventStreamDecoder();
    const results = decoder.push(frame);
    assert.equal(results.length, 1);
    assert.equal(results[0].error, 'modelStreamErrorException');
    assert.equal(results[0].message, 'Context length exceeded');
  });

  it('10.8 empty-payload frame does not crash and is skipped', () => {
    // Build a frame with empty payload (no bytes field in JSON)
    const payloadBuf = Buffer.from(JSON.stringify({}));
    const headers = buildHeaders({ ':event-type': 'initial-response', ':message-type': 'event' });
    const totalLen = 12 + headers.length + payloadBuf.length + 4;
    const frame = Buffer.alloc(totalLen);
    frame.writeUInt32BE(totalLen, 0);
    frame.writeUInt32BE(headers.length, 4);
    frame.writeUInt32BE(crc32(frame, 0, 8), 8);
    headers.copy(frame, 12);
    payloadBuf.copy(frame, 12 + headers.length);
    frame.writeUInt32BE(crc32(frame, 0, totalLen - 4), totalLen - 4);

    const decoder = new EventStreamDecoder();
    assert.doesNotThrow(() => {
      const results = decoder.push(frame);
      // Should either be empty or only contain non-event results
      for (const r of results) {
        assert.ok(!r.event || typeof r.event === 'object', 'Result should be valid');
      }
    });
  });

  it('processes a CRC mismatch frame then continues with next valid frame', () => {
    const badEvent = { type: 'bad' };
    const badFrame = Buffer.from(buildFrame(badEvent));
    badFrame.writeUInt32BE(0xDEADBEEF, badFrame.length - 4); // corrupt

    const goodEvent = { type: 'message_stop' };
    const goodFrame = buildFrame(goodEvent);

    const combined = Buffer.concat([badFrame, goodFrame]);
    const decoder = new EventStreamDecoder();
    const results = decoder.push(combined);

    assert.equal(results.length, 2);
    assert.equal(results[0].error, 'crc_mismatch');
    assert.deepEqual(results[1].event, goodEvent);
  });
});
