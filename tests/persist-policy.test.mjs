import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestPersistence, shouldShowStorageNotice, formatEstimate, readEstimate } from '../js/store/persist.js';
import { decideLoadFailure, FAILED_MESSAGE } from '../js/audio/load-policy.js';

test('requestPersistence: unavailable without the API', async () => {
  assert.equal(await requestPersistence(undefined), 'unavailable');
  assert.equal(await requestPersistence({}), 'unavailable');
});

test('requestPersistence: already persisted skips the request', async () => {
  let asked = false;
  const s = { persisted: async () => true, persist: async () => ((asked = true), false) };
  assert.equal(await requestPersistence(s), 'granted');
  assert.equal(asked, false);
});

test('requestPersistence: granted, denied, throwing', async () => {
  assert.equal(await requestPersistence({ persist: async () => true }), 'granted');
  assert.equal(await requestPersistence({ persisted: async () => false, persist: async () => false }), 'denied');
  assert.equal(await requestPersistence({ persist: async () => { throw new Error('x'); } }), 'unavailable');
});

test('notice shows only when not granted and not dismissed', () => {
  assert.equal(shouldShowStorageNotice({ status: 'denied', dismissed: false }), true);
  assert.equal(shouldShowStorageNotice({ status: 'unavailable', dismissed: false }), true);
  assert.equal(shouldShowStorageNotice({ status: 'denied', dismissed: true }), false);
  assert.equal(shouldShowStorageNotice({ status: 'granted', dismissed: false }), false);
  assert.equal(shouldShowStorageNotice({ status: null, dismissed: false }), false);
});

test('formatEstimate', async () => {
  assert.equal(formatEstimate({ usage: 120 * 1024 ** 2, quota: 2 * 1024 ** 3 }), '120 MB of 2.0 GB used');
  assert.equal(formatEstimate({ usage: 0, quota: 1024 ** 2 }), '1 MB of 1 MB used');
  assert.equal(formatEstimate({}), null);
  assert.equal(formatEstimate(null), null);
  assert.equal(await readEstimate(undefined), null);
  assert.equal(await readEstimate({ estimate: async () => { throw new Error('x'); } }), null);
  assert.equal(await readEstimate({ estimate: async () => ({ usage: 5 * 1024 ** 2, quota: 1024 ** 3 }) }), '5 MB of 1.0 GB used');
});

test('decideLoadFailure never removes: it toasts and marks the library item', () => {
  assert.deepEqual(decideLoadFailure({ ok: true }, { id: 'a' }), { message: null, markFailed: false });
  for (const duration of [null, 200]) {
    const v = decideLoadFailure({ ok: false }, { id: 'a', duration });
    assert.deepEqual(v, { message: FAILED_MESSAGE, markFailed: true });
    assert.equal('remove' in v, false);
  }
  assert.deepEqual(decideLoadFailure({ ok: false, oom: true }, { id: 'a', duration: null }), { message: null, markFailed: true });
  assert.deepEqual(decideLoadFailure({ ok: false }, { id: 'demo:x' }), { message: FAILED_MESSAGE, markFailed: false });
});

test('Library.init asks for persistence when stored tracks exist, and reports the result', async () => {
  const { Library } = await import('../js/store/db.js');
  const lib = new Library();
  lib.db = { transaction: () => ({ objectStore: () => ({ count: () => ({}) }) }) };
  // stub the existing-tracks check and the storage API
  lib.list = async () => [{ id: 'x' }];
  const seen = [];
  lib.onPersistence = (s) => seen.push(s);
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { storage: { persisted: async () => false, persist: async () => false } }, configurable: true });
  try {
    await lib._protectExisting();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(seen, ['denied']);
    assert.equal(lib.persistence, 'denied');
    lib._persistAsked = false;
    lib.list = async () => [];
    seen.length = 0;
    await lib._protectExisting();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(seen, []);
  } finally {
    if (prev) Object.defineProperty(globalThis, 'navigator', prev);
    else delete globalThis.navigator;
  }
});
