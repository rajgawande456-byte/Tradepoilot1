import test from 'node:test';
import assert from 'node:assert/strict';
import { assessUpstoxSnapshotFreshness } from './upstox-snapshot-freshness.mjs';

const now = Date.parse('2026-11-26T07:30:00.000Z');
const iso = new Date(now).toISOString();

test('marks a recent provider timestamp as live and preserves its market time', () => {
  assert.deepEqual(
    assessUpstoxSnapshotFreshness(now - 4000, now),
    {
      live: true,
      timestamp: new Date(now - 4000).toISOString(),
      freshnessMs: 4000,
      freshnessStatus: 'fresh'
    }
  );
});

test('accepts provider epoch seconds and ISO timestamps', () => {
  assert.equal(assessUpstoxSnapshotFreshness(now / 1000, now).live, true);
  assert.equal(assessUpstoxSnapshotFreshness(iso, now).timestamp, iso);
});

test('marks old quotes stale instead of calling them live', () => {
  const result = assessUpstoxSnapshotFreshness(now - 15001, now);
  assert.equal(result.live, false);
  assert.equal(result.freshnessStatus, 'stale');
  assert.equal(result.timestamp, new Date(now - 15001).toISOString());
});

test('does not invent a timestamp when provider time is missing or invalid', () => {
  for (const value of [null, undefined, '', 'not-a-date', 0]) {
    const result = assessUpstoxSnapshotFreshness(value, now);
    assert.equal(result.live, false, String(value));
    assert.equal(result.timestamp, null, String(value));
    assert.equal(result.freshnessStatus, 'timestamp_unavailable');
  }
});

test('rejects provider timestamps too far in the future', () => {
  const result = assessUpstoxSnapshotFreshness(now + 5001, now);
  assert.equal(result.live, false);
  assert.equal(result.timestamp, null);
  assert.equal(result.freshnessStatus, 'timestamp_unavailable');
});
