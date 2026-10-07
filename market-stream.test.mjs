import assert from 'node:assert/strict';
import { normalizeTick, validateSequenceAndFreshness } from './tick.mjs';

import { createMarketStream, websocketAcceptKey, isAllowedSymbol } from './market/stream.mjs';

import { verifyWebSocketAccess } from './market/ws-transport.mjs';

const now = new Date().toISOString();
const good = { symbol: 'NIFTY 50', sequence: 1, price: 25000, asOf: now };
assert.equal(normalizeTick(good).sequence, 1);
assert.throws(() => normalizeTick({ ...good, sequence: 'x' }), /sequence\/price\/timestamp/);
assert.throws(() => validateSequenceAndFreshness({ ...good, asOf: new Date(Date.now() - 60000).toISOString() }, undefined, 15000), /freshness/);
assert.throws(() => validateSequenceAndFreshness({ ...good, sequence: 1 }, 1, 15000), /strictly increasing/);
assert.equal(isAllowedSymbol('BANKNIFTY'), true);
assert.equal(isAllowedSymbol('RELIANCE'), false);
const stream = createMarketStream({ provider: { name: 'test' }, maxAgeMs: 15000 });
const sent = [];
const off = stream.addClient({ send: x => sent.push(JSON.parse(x)) }, 'NIFTY 50');
const tick = stream.publish(good, 'test');
assert.equal(tick.sequence, 1);
assert.equal(sent[1].type, 'market_tick');
off();
assert.equal(stream.clientCount(), 0);
assert.throws(() => createMarketStream({ provider: null }).publish(good), /configured/);
assert.throws(() => verifyWebSocketAccess({ headers: {} }, { expectedToken: 'server-token' }), /authentication is required/);
assert.equal(websocketAcceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
console.log('market-stream.test.mjs: PASS');
