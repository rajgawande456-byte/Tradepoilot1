import crypto from 'node:crypto';
import { normalizeTick, validateSequenceAndFreshness } from './tick.mjs';

export class MarketStreamError extends Error {
  constructor(code, message, status = 503) { super(message); this.code = code; this.status = status; }
}

const ALLOWED_SYMBOLS = new Set(['NIFTY 50', 'BANKNIFTY', 'FINNIFTY']);

export function isAllowedSymbol(symbol) { return ALLOWED_SYMBOLS.has(String(symbol || '').trim()); }

export function createMarketStream({ provider = null, maxAgeMs = 15000 } = {}) {
  const clients = new Set();
  const lastSeq = new Map();

  function authorizeSymbol(symbol) {
    if (!isAllowedSymbol(symbol)) throw new MarketStreamError('SYMBOL_NOT_ALLOWED', 'Requested market symbol is not allow-listed.', 403);
  }

  function publish(raw, providerName = 'verified-provider') {
    if (!provider) throw new MarketStreamError('MARKET_DATA_NOT_CONFIGURED', 'No verified market-data provider is configured.');
    const tick = normalizeTick(raw, providerName);
    authorizeSymbol(tick.symbol);
    const validated = validateSequenceAndFreshness(tick, lastSeq.get(tick.symbol), maxAgeMs);
    lastSeq.set(tick.symbol, validated.sequence);
    const message = JSON.stringify({ type: 'market_tick', data: validated });
    for (const client of clients) {
      try { client.send(message); } catch { clients.delete(client); }
    }
    return validated;
  }

  return {
    configured: Boolean(provider),
    protocol: 'websocket',
    allowedSymbols: [...ALLOWED_SYMBOLS],
    addClient(socket, symbol) {
      if (!provider) throw new MarketStreamError('MARKET_DATA_NOT_CONFIGURED', 'No verified market-data provider is configured.');
      authorizeSymbol(symbol);
      clients.add(socket);
      socket.send(JSON.stringify({ type: 'stream_status', status: 'connected', symbol, transport: 'websocket' }));
      return () => clients.delete(socket);
    },
    publish,
    clientCount: () => clients.size,
    resetSequences: () => lastSeq.clear()
  };
}

export function websocketAcceptKey(secWebSocketKey) {
  return crypto.createHash('sha1').update(`${secWebSocketKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}
