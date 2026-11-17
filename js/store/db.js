// Track library: original file Blobs + metadata in IndexedDB.
//
// If IndexedDB is unavailable (private mode, blocked) or a write fails (quota), the library
// keeps working from an in-memory map for the rest of the session and calls notify().
//
// Metadata record: { id, name, size, type, duration|null, bpm|null, beatOffset|null,
//                    bpmConfidence|null, bpmSource|null, addedAt }

import { requestPersistence } from './persist.js';

const DB_NAME = 'dj-mobile';
const DB_VERSION = 1;
const META = 'tracks';
const BLOBS = 'blobs';

const reqDone = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const txDone = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });

function newId() {
  // crypto.randomUUID is secure-context only; the app may be served over plain http on a LAN.
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function isQuota(err) {
  return !!err && (err.name === 'QuotaExceededError' || err.code === 22);
}

export class Library {
  /** @param {{notify?:(message:string)=>void}} [opts] */
  constructor({ notify } = {}) {
    this.notify = notify || (() => {});
    this.db = null;
    this.memory = new Map(); // id -> { meta, blob }: session-only items
    this._warnedMemory = false;
    this._persistAsked = false;
    this.persistence = null; // 'granted' | 'denied' | 'unavailable' once asked
    this.onPersistence = null;
  }

  /** True when new tracks are being persisted. */
  get persistent() {
    return this.db !== null;
  }

  async init() {
    try {
      if (!globalThis.indexedDB) throw new Error('IndexedDB unavailable');
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
      };
      const db = await reqDone(req);
      db.onversionchange = () => {
        db.close();
        this.db = null;
      };
      db.onclose = () => {
        this.db = null;
      };
      this.db = db;
      this._protectExisting();
    } catch {
      this.db = null;
      this._warnMemory('Storage is unavailable here, so your library will only last for this session.');
    }
  }

  /** An existing library (from an earlier visit) gets the same protection and notice. Never throws or blocks. */
  async _protectExisting() {
    try {
      if ((await this.list()).some((t) => !t.sessionOnly)) this._askPersistence();
    } catch {
      /* best effort */
    }
  }

  /** After the first stored user track: ask the browser to keep our storage. Fire and forget; never throws. */
  _askPersistence() {
    if (this._persistAsked) return;
    this._persistAsked = true;
    requestPersistence().then((status) => {
      this.persistence = status;
      try {
        this.onPersistence?.(status);
      } catch {
        /* a UI hook must not break storage */
      }
    });
  }

  _warnMemory(message) {
    if (this._warnedMemory) return;
    this._warnedMemory = true;
    this.notify(message);
  }

  /** All tracks, newest first (persisted + session-only). */
  async list() {
    let items = [];
    if (this.db) {
      try {
        const tx = this.db.transaction(META, 'readonly');
        items = await reqDone(tx.objectStore(META).getAll());
      } catch {
        items = [];
      }
    }
    for (const { meta } of this.memory.values()) items.push({ ...meta, sessionOnly: true });
    return items.sort((a, b) => b.addedAt - a.addedAt);
  }

  /** Store a file. Falls back to memory (with a notice) if persisting fails. Always resolves a meta record. */
  async add(file) {
    const meta = {
      id: newId(),
      name: file.name || 'Untitled',
      size: file.size,
      type: file.type || '',
      duration: null,
      bpm: null,
      beatOffset: null,
      bpmConfidence: null,
      bpmSource: null,
      addedAt: Date.now(),
    };
    // Store a plain Blob built from the bytes, not the File: iOS Safari can lose File-backed
    // blobs in IndexedDB after a reload.
    let blob;
    try {
      blob = new Blob([await file.arrayBuffer()], { type: file.type });
    } catch {
      blob = file;
    }
    if (this.db) {
      try {
        const tx = this.db.transaction([META, BLOBS], 'readwrite');
        tx.objectStore(META).put(meta);
        tx.objectStore(BLOBS).put(blob, meta.id);
        await txDone(tx);
        this._askPersistence();
        return meta;
      } catch (err) {
        this.notify(
          isQuota(err)
            ? `Storage is full, so "${meta.name}" is kept for this session only.`
            : `Couldn't save "${meta.name}" to the library, so it is kept for this session only.`,
        );
      }
    } else {
      this._warnMemory('Storage is unavailable here, so your library will only last for this session.');
    }
    this.memory.set(meta.id, { meta, blob });
    return { ...meta, sessionOnly: true };
  }

  /** @returns {Promise<Blob|null>} */
  async getBlob(id) {
    const mem = this.memory.get(id);
    if (mem) return mem.blob;
    if (!this.db) return null;
    try {
      const tx = this.db.transaction(BLOBS, 'readonly');
      return (await reqDone(tx.objectStore(BLOBS).get(id))) || null;
    } catch {
      return null;
    }
  }

  /** Merge fields into a track's metadata (duration, bpm, beatOffset...). Best effort. */
  async update(id, patch) {
    const mem = this.memory.get(id);
    if (mem) {
      Object.assign(mem.meta, patch);
      return;
    }
    if (!this.db) return;
    try {
      const tx = this.db.transaction(META, 'readwrite');
      const store = tx.objectStore(META);
      const meta = await reqDone(store.get(id));
      if (meta) store.put({ ...meta, ...patch });
      await txDone(tx);
    } catch {
      /* metadata is re-derivable; losing an update is harmless */
    }
  }

  async remove(id) {
    if (this.memory.delete(id)) return;
    if (!this.db) return;
    try {
      const tx = this.db.transaction([META, BLOBS], 'readwrite');
      tx.objectStore(META).delete(id);
      tx.objectStore(BLOBS).delete(id);
      await txDone(tx);
    } catch {
      this.notify("Couldn't delete that track from storage.");
    }
  }
}
