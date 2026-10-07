import crypto from 'node:crypto';

import { websocketAcceptKey, MarketStreamError } from './stream.mjs';

export function isWebSocketUpgrade(req) {
  return (
    String(req.headers.upgrade || '').toLowerCase() === 'websocket' &&
    String(req.headers['sec-websocket-key'] || '').length > 0
  );
}

export function upgradeResponseHeaders(req) {
  const key = req.headers['sec-websocket-key'];

  return [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${websocketAcceptKey(key)}`,
    'Sec-WebSocket-Version: 13',
    '\r\n'
  ].join('\r\n');
}

export function createWebSocketClient(socket) {
  return {
    socket,

    send(payload) {
      const body = Buffer.from(String(payload));

      if (body.length >= 126) {
        throw new Error('FRAME_TOO_LARGE');
      }

      const frame = Buffer.concat([
        Buffer.from([0x81, body.length]),
        body
      ]);

      socket.write(frame);
    },

    close(code = 1000) {
      const buf = Buffer.alloc(2);
      buf.writeUInt16BE(code, 0);

      socket.write(
        Buffer.concat([
          Buffer.from([0x88, 2]),
          buf
        ])
      );

      socket.end();
    }
  };
}

export function extractBearer(req) {
  const value = String(req.headers.authorization || '');

  return value.startsWith('Bearer ')
    ? value.slice(7).trim()
    : '';
}

export function verifyWebSocketAccess(
  req,
  { expectedToken = '' } = {}
) {
  if (!expectedToken) {
    throw new MarketStreamError(
      'AUTH_NOT_CONFIGURED',
      'WebSocket authentication is not configured.',
      503
    );
  }

  const token = extractBearer(req);

  if (!token) {
    throw new MarketStreamError(
      'AUTH_REQUIRED',
      'Server-issued authentication is required for the market stream.',
      401
    );
  }

  const a = Buffer.from(token);
  const b = Buffer.from(expectedToken);

  if (
    a.length !== b.length ||
    !crypto.timingSafeEqual(a, b)
  ) {
    throw new MarketStreamError(
      'AUTH_REQUIRED',
      'Server-issued authentication is required for the market stream.',
      401
    );
  }

  return true;
}
