import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
const source = readFileSync(new URL('../src/renderer/components/music/BarrageLayer.vue', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('async function load('), source.indexOf('\nwatch(', source.indexOf('async function load(')));
const code = transformSync(handler, { loader: 'ts' }).code;
const a = { text: 'a', userId: '1' }, b = { text: 'b', userId: '2' }, c = { text: 'c', userId: '3' };
function setup(getBarrage) {
  const state = { items: { value: [a, b] }, flights: { value: [{ ...a, id: 1, lane: 0 }] }, loading: { value: false }, error: { value: '' } };
  const props = { hash: 'song', type: 'song' };
  const run = new Function('items', 'flights', 'loading', 'error', 'props', 'getBarrage', `
    let generation = 0, cursor = 1;
    const pendingOwn = { value: [] }, recentOwn = new Map();
    const enabled = { value: true }, active = { value: true };
    const normalizeBarrageItems = value => value;
    ${code}
    return { load, cursor: () => cursor, advance: () => cursor++ };
  `)(state.items, state.flights, state.loading, state.error, props, getBarrage);
  return { ...state, ...run, props };
}
test('send refresh preserves flying objects and follows the current cursor while fetching', async () => {
  let resolve;
  const s = setup(() => new Promise(r => { resolve = r; }));
  const flights = s.flights.value;
  const pending = s.load(true);
  assert.deepEqual(s.items.value, [a, b]);
  assert.equal(s.loading.value, false);
  s.advance(); // next is a, not the b that was next when the request started
  resolve({ list: [c, a, b] });
  await pending;
  assert.equal(s.flights.value, flights);
  assert.equal(s.items.value[s.cursor()], a);
});
test('empty or failed background refresh keeps the existing playback pool', async () => {
  for (const fetch of [async () => ({ list: [] }), async () => { throw new Error('offline'); }]) {
    const s = setup(fetch), items = s.items.value, flights = s.flights.value;
    await s.load(true);
    assert.equal(s.items.value, items);
    assert.equal(s.flights.value, flights);
    assert.equal(s.cursor(), 1);
    assert.equal(s.error.value, '');
  }
});
test('resource reset invalidates an older send refresh', async () => {
  let resolve;
  const s = setup(() => s.props.hash === 'song' ? new Promise(r => { resolve = r; }) : Promise.resolve({ list: [c] }));
  const old = s.load(true);
  s.props.hash = 'other';
  await s.load();
  resolve({ list: [a, b] });
  await old;
  assert.deepEqual(s.items.value, [c]);
  assert.deepEqual(s.flights.value, []);
  assert.equal(s.cursor(), 0);
});
test('successful send waits for a free lane without replacing existing flights', () => {
  const start = source.indexOf('function launchNext(');
  const handlers = transformSync(source.slice(start, source.indexOf('watch(', start)), { loader: 'ts' }).code;
  const original = Array.from({ length: 4 }, (_, lane) => ({ id: lane + 1, lane, text: 'old', userId: '2' }));
  const flights = { value: [...original] }, pendingOwn = { value: [] }, recentOwn = new Map();
  const run = new Function('flights', 'pendingOwn', 'recentOwn', `
    const running = { value: true }, enabled = { value: true }, active = { value: true };
    const props = { hash: 'song' }, currentUserId = { value: '1' }, config = { value: { speed: 1 } };
    let sequence = 4, cursor = 0;
    const items = { value: [] };
    const getFreeBarrageLane = list => [0,1,2,3].find(lane => !list.some(item => item.lane === lane)) ?? -1;
    const barrageIdentity = item => JSON.stringify([item.userId, item.text]);
    const load = () => {};
    const nextBarrageItem = () => ({ cursor });
    ${handlers}
    return { onSent, finishFlight };
  `)(flights, pendingOwn, recentOwn);
  run.onSent('mine');
  assert.deepEqual(flights.value, original);
  assert.equal(pendingOwn.value.length, 1);
  run.finishFlight(2);
  assert.deepEqual(flights.value.slice(0, 3), [original[0], original[2], original[3]]);
  assert.deepEqual(flights.value[3], { id: 5, lane: 1, text: 'mine', userId: '1' });
  assert.equal(pendingOwn.value.length, 0);
});
