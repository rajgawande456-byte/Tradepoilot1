import test from 'node:test';
import assert from 'node:assert/strict';
import { chartContextKey, canReuseChartData } from './chart-context.mjs';

test('chart context includes both the selected symbol and interval', () => {
  assert.equal(chartContextKey('NIFTY 50', '5'), 'NIFTY 50:5');
  assert.equal(chartContextKey(' BANKNIFTY ', '15'), 'BANKNIFTY:15');
  assert.equal(chartContextKey('', '5'), '');
  assert.equal(chartContextKey('NIFTY 50', ''), '');
});

test('retains last good candles only for the same symbol and interval', () => {
  const loaded = chartContextKey('NIFTY 50', '5');
  assert.equal(canReuseChartData(loaded, chartContextKey('NIFTY 50', '5'), true), true);
  assert.equal(canReuseChartData(loaded, chartContextKey('BANKNIFTY', '5'), true), false);
  assert.equal(canReuseChartData(loaded, chartContextKey('NIFTY 50', '15'), true), false);
  assert.equal(canReuseChartData(loaded, loaded, false), false);
  assert.equal(canReuseChartData('', loaded, true), false);
});
