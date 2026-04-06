'use strict';

// ── CRC32 (IEEE 802.3 / zlib polynomial 0xEDB88320) ─────────────────

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf, offset, length) {
  let crc = 0xFFFFFFFF;
  const end = offset + length;
  for (let i = offset; i < end; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── AWS EventStream binary frame format ─────────────────────────────
//
// Prelude (12 bytes):
//   [0-3]  total_length   uint32 BE  — total bytes including prelude + headers + payload + CRCs
//   [4-7]  headers_length uint32 BE  — byte length of headers section
//   [8-11] prelude_crc    uint32 BE  — CRC32 of bytes [0..7]
//
// Headers (variable, headers_length bytes):
//   Each header entry:
//     [0]         name_length  uint8   — byte length of header name
//     [1..n]      name         string  — header name (name_length bytes)
//     [n+1]       value_type   uint8   — 7 = string
//     [n+2..n+3]  value_length uint16 BE
//     [n+4..]     value        string  — value_length bytes
//
// Payload:
//   total_length - 12 (prelude) - headers_length - 4 (message CRC) bytes
//
// Message CRC (4 bytes):
//   CRC32 of all bytes from [0 .. total_length - 5]

class EventStreamDecoder {
  constructor() {
    this._buf = Buffer.alloc(0);
  }

  // Push a chunk of binary data. Returns an array of result objects:
  //   { event: <parsed-event-object> }             — success
  //   { error: 'crc_mismatch' }                    — prelude or message CRC failed
  //   { error: 'modelStreamErrorException', message } — Bedrock stream error event
  //   (empty frames / non-chunk events are silently skipped)
  push(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    const results = [];

    while (true) {
      if (this._buf.length < 12) break; // need at least prelude

      const totalLength = this._buf.readUInt32BE(0);
      if (this._buf.length < totalLength) break; // incomplete frame

      const headersLength = this._buf.readUInt32BE(4);
      const preludeCrc = this._buf.readUInt32BE(8);
      const expectedPreludeCrc = crc32(this._buf, 0, 8);

      if (preludeCrc !== expectedPreludeCrc) {
        results.push({ error: 'crc_mismatch' });
        // Skip this frame and try to resync
        this._buf = this._buf.slice(totalLength);
        continue;
      }

      const messageCrc = this._buf.readUInt32BE(totalLength - 4);
      const expectedMessageCrc = crc32(this._buf, 0, totalLength - 4);

      if (messageCrc !== expectedMessageCrc) {
        results.push({ error: 'crc_mismatch' });
        this._buf = this._buf.slice(totalLength);
        continue;
      }

      // Parse headers
      const headers = {};
      let pos = 12;
      const headersEnd = 12 + headersLength;
      while (pos < headersEnd) {
        const nameLen = this._buf[pos++];
        const name = this._buf.slice(pos, pos + nameLen).toString('utf8');
        pos += nameLen;
        const valueType = this._buf[pos++];
        if (valueType === 7) { // string
          const valueLen = this._buf.readUInt16BE(pos);
          pos += 2;
          const value = this._buf.slice(pos, pos + valueLen).toString('utf8');
          pos += valueLen;
          headers[name] = value;
        } else {
          // Skip unknown value types gracefully
          break;
        }
      }

      // Extract payload
      const payloadStart = headersEnd;
      const payloadEnd = totalLength - 4;
      const payloadBuf = this._buf.slice(payloadStart, payloadEnd);

      // Consume this frame from the buffer
      this._buf = this._buf.slice(totalLength);

      const eventType = headers[':event-type'] || '';
      const messageType = headers[':message-type'] || '';

      // Handle Bedrock stream error
      if (eventType === 'modelStreamErrorException' || messageType === 'exception') {
        let message = eventType;
        try {
          const body = JSON.parse(payloadBuf.toString('utf8'));
          message = body.message || body.Message || eventType;
        } catch {}
        results.push({ error: 'modelStreamErrorException', message });
        continue;
      }

      // Only process 'chunk' events — others (initial-response, etc.) are skipped
      if (eventType !== 'chunk' && payloadBuf.length === 0) continue;

      // Decode payload: {"bytes":"<base64>"} → Anthropic SSE event JSON
      let event = null;
      try {
        const payloadJson = JSON.parse(payloadBuf.toString('utf8'));
        const decoded = Buffer.from(payloadJson.bytes || '', 'base64').toString('utf8');
        if (decoded) event = JSON.parse(decoded);
      } catch {}

      if (event) results.push({ event });
    }

    return results;
  }
}

module.exports = { EventStreamDecoder, crc32 };
