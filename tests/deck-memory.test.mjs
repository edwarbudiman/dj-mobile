// Deck memory behaviour: ask-before-decode, free a paused deck first, friendly out-of-memory failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
globalThis.AudioWorkletNode = class {
  constructor() {
    this.port = { postMessage: (m) => sent.push(m), onmessage: null };
  }
  connect() {}
};
const { Deck } = await import('../js/audio/deck.js');

const param = () => ({ value: 0, setTargetAtTime() {} });
const stubNode = () => ({ connect() {}, gain: param(), frequency: param(), Q: param(), type: '' });

function makeDeck(decodeImpl) {
  const ctx = {
    currentTime: 1,
    sampleRate: 48000,
    outputLatency: 0,
    baseLatency: 0,
    createBiquadFilter: stubNode,
    createGain: stubNode,
    decodeAudioData: decodeImpl,
  };
  const d = new Deck(ctx, 'A', stubNode(), stubNode());
  d.track = { name: 'old', duration: 10, sampleRate: 48000, length: 480000, libraryId: 'old' };
  return d;
}
const goodDecode = (_bytes, ok) =>
  ok({
    length: 480,
    numberOfChannels: 2,
    sampleRate: 48000,
    duration: 0.01,
    copyFromChannel(dst) {
      dst.fill(0.1);
    },
  });
const blob = { arrayBuffer: async () => new ArrayBuffer(8), size: 8 };

test('a "no" to the memory question cancels quietly: nothing decoded, the old track untouched, no error', async () => {
  let decoded = 0;
  const d = makeDeck((b, ok) => (decoded++, goodDecode(b, ok)));
  const errors = [];
  d.addEventListener('error', (e) => errors.push(e.detail));
  sent.length = 0;
  const res = await d.loadBlob(blob, { name: 'big' }, { beforeDecode: async () => false });
  assert.deepEqual(res, { ok: false, cancelled: true });
  assert.equal(decoded, 0);
  assert.equal(d.track.name, 'old');
  assert.equal(sent.length, 0);
  assert.equal(errors.length, 0);
  assert.equal(d.loading, false);
});

test('b-4: a small file never empties the deck first (a corrupt one leaves the old track); only a BIG one frees a paused deck', async () => {
  const bad = makeDeck((_b, _ok, fail) => fail(new Error('Unable to decode audio data')));
  sent.length = 0;
  const r = await bad.loadBlob(blob, { name: 'junk' }, { beforeDecode: async () => ({ estimateBytes: 20 * 1024 * 1024 }) });
  assert.equal(r.ok, false);
  assert.equal(bad.track.name, 'old', 'the loaded track survives a failed small load');
  assert.equal(sent.some((m) => m.type === 'unload'), false);
  const none = makeDeck((_b, _ok, fail) => fail(new Error('x')));
  await none.loadBlob(blob, { name: 'junk' }, {}); // no estimate at all: treated as small
  assert.equal(none.track.name, 'old');
});

test('a BIG new track (over 100 MB decoded) frees a paused deck first; a playing one keeps its track', async () => {
  const big = { beforeDecode: async () => ({ estimateBytes: 400 * 1024 * 1024 }) };
  const order = [];
  const d = makeDeck((b, ok) => {
    order.push('decode');
    goodDecode(b, ok);
  });
  d.addEventListener('track', (e) => order.push(e.detail.track ? 'loaded' : 'emptied'));
  sent.length = 0;
  const res = await d.loadBlob(blob, { name: 'new' }, big);
  assert.equal(res.ok, true);
  assert.deepEqual(order.slice(0, 3), ['emptied', 'decode', 'loaded'], 'old track freed, then decode, then the new track');
  assert.equal(sent.find((m) => m.type === 'unload') !== undefined, true);

  const p = makeDeck(goodDecode);
  p.playing = true;
  sent.length = 0;
  const res2 = await p.loadBlob(blob, { name: 'new' }, big);
  assert.equal(res2.ok, true);
  assert.equal(sent.some((m) => m.type === 'unload'), false, 'a playing deck is never emptied early');
});

test('releasePaused does nothing for a grabbed deck or an empty one, and resets cues, loop and grid', () => {
  const d = makeDeck(goodDecode);
  d.hotCues = [1, null, null, null];
  d.loop = { start: 1, end: 2, beats: 1 };
  d.grid = { bpm: 120, offset: 0 };
  d.grabbed = true;
  assert.equal(d.releasePaused(), false);
  d.grabbed = false;
  assert.equal(d.releasePaused(), true);
  assert.equal(d.track, null);
  assert.deepEqual(d.hotCues, [null, null, null, null]);
  assert.equal(d.loop, null);
  assert.equal(d.grid, null);
  assert.equal(d.releasePaused(), false, 'already empty');
  assert.equal(d.position, 0);
  assert.equal(d.heardPosition, 0);
});

test('an out-of-memory failure says so and suggests a shorter file; other failures keep their own message', async () => {
  const oom = makeDeck((_b, _ok, fail) => fail(new RangeError('Array buffer allocation failed')));
  const msgs = [];
  oom.addEventListener('error', (e) => msgs.push(e.detail.message));
  const r = await oom.loadBlob(blob, { name: 'huge' }, {});
  assert.equal(r.ok, false);
  assert.equal(r.oom, true);
  assert.match(r.message, /Not enough memory.*shorter/);
  assert.deepEqual(msgs, [r.message]);

  const bad = makeDeck((_b, _ok, fail) => fail(new Error('Unable to decode audio data')));
  const r2 = await bad.loadBlob(blob, { name: 'junk' }, {});
  assert.equal(r2.oom, false);
  assert.match(r2.message, /decode/);
});

test('afterDecode reports the decoded size so the app can warn once', async () => {
  const d = makeDeck(goodDecode);
  let info = null;
  await d.loadBlob(blob, { name: 'x' }, { afterDecode: (i) => (info = i) });
  assert.deepEqual(info, { duration: 0.01, channels: 2, sampleRate: 48000 });
});
