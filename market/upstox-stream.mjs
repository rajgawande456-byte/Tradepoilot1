import WebSocket from 'ws';
import protobuf from 'protobufjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEYS = {
  'NIFTY 50': 'NSE_INDEX|Nifty 50',
  BANKNIFTY: 'NSE_INDEX|Nifty Bank',
  FINNIFTY: 'NSE_INDEX|Nifty Fin Service'
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let rootPromise;

function getFeedType() {
  if (!rootPromise) {
    rootPromise = protobuf
      .load(path.join(__dirname, 'MarketDataFeedV3.proto'))
      .then(root => root.lookupType('com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse'));
  }
  return rootPromise;
}

// Upstox V3 timestamps can be represented as seconds, milliseconds,
// microseconds, nanoseconds, or an ISO date string. Lightweight Charts
// and the market freshness validator both need a real epoch timestamp.
function toEpochMilliseconds(value) {
  if (value == null || value === '') return NaN;

  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return NaN;

  if (numeric >= 1e17) return numeric / 1e6; // nanoseconds -> milliseconds
  if (numeric >= 1e14) return numeric / 1e3; // microseconds -> milliseconds
  if (numeric >= 1e11) return numeric;       // already milliseconds
  if (numeric >= 1e9) return numeric * 1e3;  // seconds -> milliseconds
  return NaN;
}

export function startUpstoxStream({ token, marketStream, onStatus = () => {} } = {}) {
  if (!token || !marketStream) return () => {};

  let stopped = false;
  let ws = null;
  let timer = null;
  let attempt = 0;
  let seq = 0;

  async function connect() {
    if (stopped) return;

    try {
      const auth = await fetch(
        'https://api.upstox.com/v3/feed/market-data-feed/authorize',
        {
          headers: {
            Accept: 'application/json',
            Authorization: 'Bearer ' + token
          },
          signal: AbortSignal.timeout(10000)
        }
      );

      if (!auth.ok) throw new Error('Feed authorization HTTP ' + auth.status);

      const body = await auth.json();
      const url = body?.data?.authorized_redirect_uri;
      if (typeof url !== 'string' || !url.startsWith('wss://')) {
        throw new Error('Secure feed URL missing');
      }

      const FeedResponse = await getFeedType();
      ws = new WebSocket(url, { followRedirects: true, handshakeTimeout: 15000 });

      ws.on('open', () => {
        attempt = 0;
        onStatus('connected');
        ws.send(Buffer.from(JSON.stringify({
          guid: 'tradepilot-' + Date.now(),
          method: 'sub',
          data: { mode: 'full', instrumentKeys: Object.values(KEYS) }
        })), { binary: true });
      });

      ws.on('message', (data, isBinary) => {
        if (!isBinary) return;

        try {
          const decoded = FeedResponse.decode(data);
          const obj = FeedResponse.toObject(decoded, {
            longs: Number,
            enums: String,
            defaults: false
          });
          const feeds = obj.feeds || {};

          for (const [symbol, key] of Object.entries(KEYS)) {
            const feed = feeds[key];
            if (!feed) continue;

            const ltpc =
              feed.ltpc ||
              feed.ff?.indexFF?.ltpc ||
              feed.ff?.marketFF?.ltpc ||
              feed.fullFeed?.indexFF?.ltpc ||
              feed.fullFeed?.marketFF?.ltpc ||
              feed.firstLevelWithGreeks?.ltpc;

            const price = Number(ltpc?.ltp);
            // currentTs is the feed event time; use the instrument trade time
            // only when the envelope timestamp is absent.
            const rawTs = obj.currentTs ?? ltpc?.ltt ?? Date.now();
            const timestampMs = toEpochMilliseconds(rawTs);

            if (
              !Number.isFinite(price) ||
              price <= 0 ||
              !Number.isFinite(timestampMs) ||
              timestampMs < Date.UTC(2000, 0, 1) ||
              timestampMs > Date.now() + 60000
            ) continue;

            try {
              marketStream.publish({
                symbol,
                price,
                sequence: ++seq,
                asOf: new Date(timestampMs).toISOString()
              }, 'UPSTOX V3 WS');
              onStatus('tick_received:' + symbol);
            } catch (error) {
              onStatus('tick_rejected:' + symbol + ':' + (error?.code || 'unknown'));
            }
          }
        } catch {
          onStatus('decode_error');
        }
      });

      ws.on('error', () => onStatus('error'));
      ws.on('close', () => {
        onStatus('disconnected');
        schedule();
      });
    } catch (error) {
      onStatus('error:' + (error?.message || 'connection_failed'));
      schedule();
    }
  }

  function schedule() {
    if (stopped || timer) return;
    const delay = Math.min(30000, 1000 * (2 ** attempt));
    attempt += 1;
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, delay);
  }

  connect();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (ws) {
      ws.removeAllListeners('close');
      ws.close();
    }
  };
}
