// App bootstrap and wiring: engine <-> mixer/deck views <-> library <-> analysis.

import { Engine } from './audio/engine.js';
import { FADER_UNITY } from './audio/mixer-math.js';
import { prepareTrack, TempoAnalyzer } from './audio/analyzer.js';
import { phaseAlignDelta, planSync, SEEK_LATENCY } from './audio/sync-math.js';
import { Library } from './store/db.js';
import { createToaster } from './ui/toast.js';
import { createDeckView } from './ui/deck-view.js';
import { createMixerView } from './ui/mixer-view.js';
import { createLibraryView } from './ui/library-view.js';
import { createFader } from './ui/fader.js';
import { LOW_CONFIDENCE } from './audio/bpm-core.js';
import { sanitizeHotCues } from './audio/cue-math.js';
import { DEMOS, demoDuration } from './audio/demo-synth.js';
import { buildDemo } from './audio/demo-loader.js';
import { decideLoadFailure } from './audio/load-policy.js';
import { readEstimate, shouldShowStorageNotice } from './store/persist.js';
import { HEADER_BYTES, describeBeforeDecode, inspectAfterDecode, inspectBeforeDecode, parseAudioHeader, readMediaDuration } from './audio/memory-guard.js';
import { createConfirm } from './ui/confirm.js';
import { initPwa } from './pwa.js';
import { createWakeLock } from './wake-lock.js';

const $ = (id) => document.getElementById(id);
const toast = createToaster($('toasts'));
let engine = new Engine(); // replaced by a fresh one if the system closes the audio context (see wireEngine)
const library = new Library({ notify: (m) => toast(m, { kind: 'warn', ms: 6000 }) });
const tempo = new TempoAnalyzer();
const other = (id) => (id === 'A' ? 'B' : 'A');

// ---- mixer state (UI is the source of truth; pushed to the engine once it exists) ---------

const SPLIT_KEY = 'dj-mobile.splitCue';
function readSplitSetting() {
  try {
    return localStorage.getItem(SPLIT_KEY) === 'on';
  } catch {
    return false;
  }
}
function writeSplitSetting(on) {
  try {
    localStorage.setItem(SPLIT_KEY, on ? 'on' : 'off');
  } catch {
    /* not persisted: fine */
  }
}

const mixer = {
  master: FADER_UNITY,
  crossfader: 0.5,
  split: readSplitSetting(), // split-mono headphone cue (off by default)
  cueMix: 0.5,
  decks: {
    A: { volume: FADER_UNITY, high: FADER_UNITY, mid: FADER_UNITY, low: FADER_UNITY, filter: 0.5, pfl: false },
    B: { volume: FADER_UNITY, high: FADER_UNITY, mid: FADER_UNITY, low: FADER_UNITY, filter: 0.5, pfl: false },
  },
};

function applyMixer() {
  engine.setMaster(mixer.master);
  engine.setCrossfader(mixer.crossfader);
  engine.setCueMix(mixer.cueMix);
  if (mixer.split && !engine.setSplitCue(true)) {
    // a mono output cannot carry two ears: fall back to normal stereo and say so
    mixer.split = false;
    writeSplitSetting(false);
    toast('This device has a mono audio output, so split headphone cue is off.', { kind: 'warn', ms: 6000 });
  }
  showSplit();
  for (const [id, s] of Object.entries(mixer.decks)) {
    const deck = engine.decks[id];
    if (!deck) continue;
    deck.setVolume(s.volume);
    deck.setEq('high', s.high);
    deck.setEq('mid', s.mid);
    deck.setEq('low', s.low);
    deck.setFilter(s.filter);
    deck.setPfl(s.pfl);
  }
}

/** Sync the mixer controls and the settings sheet with the split-cue state. */
function showSplit() {
  mixerView.setSplitCue(mixer.split);
  libraryView.setSplitCue(mixer.split, { supported: !engine.ctx || engine.splitSupported });
}

const mixerView = createMixerView($('mixer'), {
  onEq: (id, band, v) => {
    mixer.decks[id][band] = v;
    engine.decks[id]?.setEq(band, v);
  },
  onFilter: (id, v) => {
    mixer.decks[id].filter = v;
    engine.decks[id]?.setFilter(v);
  },
  onPfl: (id, on) => {
    mixer.decks[id].pfl = on;
    engine.decks[id]?.setPfl(on);
  },
  onCueMix: (v) => {
    mixer.cueMix = v;
    engine.setCueMix(v);
  },
  onVolume: (id, v) => {
    mixer.decks[id].volume = v;
    engine.decks[id]?.setVolume(v);
  },
  onCrossfader: (v) => {
    mixer.crossfader = v;
    engine.setCrossfader(v);
  },
});

// ---- file picking -------------------------------------------------------------------------

const fileInput = $('file-input');
let pickTarget = null; // deck id to load the first picked file into, or null = library only

function pickFiles(target) {
  pickTarget = target;
  fileInput.value = '';
  fileInput.click();
}

fileInput.addEventListener('change', () => {
  const files = [...fileInput.files];
  const target = pickTarget;
  fileInput.value = '';
  handleFiles(files, target);
});

async function handleFiles(files, target) {
  if (!files.length) return;
  const added = [];
  for (const file of files) added.push({ file, item: await library.add(file) });
  await refreshLibrary();
  if (target) {
    libraryView.close();
    await loadIntoDeck(target, added[0].file, added[0].item);
  }
  else toast(`Added ${added.length} track${added.length === 1 ? '' : 's'} to the library`);
}

// ---- loading, analysis, grid persistence --------------------------------------------------

// ---- demo loops: synthesized on first use, never stored in IndexedDB ---------------------------

const isDemo = (id) => typeof id === 'string' && id.startsWith('demo:');
const DEMO_META_PREFIX = 'dj-mobile.demo.';

function demoMeta(id) {
  try {
    return JSON.parse(localStorage.getItem(DEMO_META_PREFIX + id)) || {};
  } catch {
    return {};
  }
}

/** The demo entries shown at the top of the library: BPM and offset are known, no analysis needed. */
function demoItems() {
  return DEMOS.map((d) => ({
    id: d.id,
    name: `${d.name} (${d.bpm} BPM)`,
    demo: true,
    duration: demoDuration(d),
    size: 0,
    bpm: d.bpm,
    beatOffset: 0,
    bpmConfidence: 1,
    bpmSource: 'demo',
    hotCues: demoMeta(d.id).hotCues,
    addedAt: Infinity,
  }));
}

/**
 * Loader for Deck.loadChannels. Nothing is cached: a demo is rendered on demand (in a Worker, so it costs the UI
 * nothing) and its sample arrays go straight to the deck, which takes ownership of them. No second copy exists,
 * no copy is made for the deck, and nothing stays in memory after a deck is reloaded.
 */
function demoProducer(id) {
  return async (isCurrent) => {
    const def = DEMOS.find((d) => d.id === id);
    const pcm = await buildDemo(def);
    if (!pcm || !isCurrent()) return null;
    return { left: pcm.left, right: pcm.right, sampleRate: pcm.sampleRate, length: pcm.length, duration: pcm.duration };
  };
}

/** Library metadata for a track; demos keep theirs (hot cues) in localStorage. */
function saveMeta(id, patch) {
  if (!id) return;
  if (isDemo(id)) {
    if (!('hotCues' in patch)) return; // a demo's tempo is fixed
    try {
      localStorage.setItem(DEMO_META_PREFIX + id, JSON.stringify({ ...demoMeta(id), hotCues: patch.hotCues }));
    } catch {
      /* not persisted: fine */
    }
    return;
  }
  library.update(id, patch);
}

// ---- memory guard: ask before decoding something huge, warn once after ---------------------------

const confirmUi = createConfirm($('confirm'));
let warnedDecodedSize = false;

/**
 * Resolves false (the user said no), or {estimateBytes}: what decoding is expected to need, so the deck can decide
 * whether to free its old track first. The length comes from a WAV / AIFF header, else from the media metadata
 * (an <audio> element reads it without decoding), else from a conservative size guess.
 */
async function askBeforeDecode(blob, item = null) {
  // A library track whose length (and channel count) was stored on its first load needs no reading at all.
  const known = item && item.duration > 0 ? { knownDuration: item.duration, knownChannels: item.channels } : null;
  let header = null;
  let mediaDuration = null;
  if (!known) {
    try {
      header = parseAudioHeader(new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer()), blob.size);
    } catch {
      header = null;
    }
    mediaDuration = header ? null : await readMediaDuration(blob);
  }
  const contextRate = engine.ctx ? engine.ctx.sampleRate : undefined; // decodeAudioData resamples to this
  const info = inspectBeforeDecode({ size: blob.size, header, mediaDuration, ...known, contextRate });
  if (info.warn) {
    const text = describeBeforeDecode(blob.name || 'This file', info, blob.size);
    if (!(await confirmUi.ask({ ...text, confirmText: 'Load anyway', cancelText: 'Cancel' }))) return false;
  }
  return { estimateBytes: info.estimateBytes };
}

function warnAfterDecode(info) {
  const r = inspectAfterDecode(info);
  if (!r.warn || warnedDecodedSize) return;
  warnedDecodedSize = true;
  toast(`That track needs about ${r.mb} MB of memory. If the app slows down or closes, try shorter tracks.`, { kind: 'warn', ms: 8000 });
}

/** `source` is a Blob (a stored file) or a producer function (a demo). */
async function loadIntoDeck(deckId, source, item) {
  const deck = engine.decks[deckId];
  if (!deck) {
    toast('Start the audio engine first.', { kind: 'warn' });
    return;
  }
  // A track reloaded from the library reuses its stored tempo instead of re-analysing.
  const stored = item.bpm > 0 && Number.isFinite(item.beatOffset);
  const hooks = {
    beforeTransfer: (channels, ctl) => prepareTrack(channels, { needBpm: !stored }, () => !ctl.isCurrent()),
    beforeDecode: (blob) => askBeforeDecode(blob, item),
    afterDecode: (info) => {
      warnAfterDecode(info);
      if (!isDemo(item.id) && item.channels == null) {
        item.channels = info.channels; // next time the memory check can skip reading the file
        library.update(item.id, { channels: info.channels });
      }
    },
  };
  const meta = { name: item.name, libraryId: item.id };
  let res;
  if (typeof source === 'function') {
    res = await deck.loadChannels(source, meta, { ...hooks, label: 'Building demo…' });
  } else {
    res = await deck.loadBlob(source, meta, hooks);
  }
  if (res.superseded || res.cancelled) return; // cancelled: the user said no to the memory warning; nothing changed
  if (!res.ok) {
    // (the deck already told the user about an out-of-memory failure; a paused deck's old track was freed first)
    const verdict = decideLoadFailure(res, item);
    if (verdict.message) toast(verdict.message, { kind: 'error', ms: 7000 });
    if (verdict.markFailed) {
      item.lastError = true;
      await library.update(item.id, { lastError: true });
      refreshLibrary();
    }
    return;
  }
  if (item.lastError) {
    item.lastError = false;
    library.update(item.id, { lastError: false }).then(() => refreshLibrary());
  }
  cancelAnalysis(deckId); // only now is the previous track's analysis obsolete
  deckViews[deckId].setPeaks(res.prepared.peaks);
  deck.setHotCues(sanitizeHotCues(item.hotCues, res.duration), { persist: false }); // restore this track's hot cues

  if (stored) {
    deck.setGrid(
      { bpm: item.bpm, offset: item.beatOffset, confidence: item.bpmConfidence ?? 1, source: item.bpmSource || 'stored' },
      { persist: false },
    );
  } else if (res.prepared.bpmInput) {
    runTempoAnalysis(deck, res.prepared.bpmInput);
  }
  if (item.duration == null) {
    item.duration = res.duration;
    await library.update(item.id, { duration: res.duration });
    refreshLibrary();
  }
}

const analysisJobs = {}; // deck id -> running tempo job (cancelled when its track is replaced)

function cancelAnalysis(deckId) {
  analysisJobs[deckId]?.cancel();
  delete analysisJobs[deckId];
}

async function runTempoAnalysis(deck, input) {
  const track = deck.track;
  cancelAnalysis(deck.id);
  deck.analyzing = true;
  deckViews[deck.id].refresh();
  const job = tempo.analyze(input);
  analysisJobs[deck.id] = job;
  let result = null;
  try {
    result = await job.promise;
  } catch (err) {
    if (err && err.name === 'AbortError') return; // superseded: whoever cancelled it owns the UI state
    result = null;
  }
  if (analysisJobs[deck.id] === job) delete analysisJobs[deck.id];
  if (deck.track !== track) return; // another track was loaded meanwhile
  deck.analyzing = false;
  if (!deck.grid) {
    if (result && result.bpm) {
      deck.setGrid({ bpm: result.bpm, offset: result.offset, confidence: result.confidence, source: 'auto' });
    } else {
      toast(`Couldn't detect a tempo for deck ${deck.id}. Use TAP to set it.`, { kind: 'warn' });
    }
  }
  deckViews[deck.id].refresh();
  updateSyncButtons();
}

// Every grid edit (analysis, TAP, x2, nudge, shift) is saved to the library metadata.
const persistTimers = {};
function persistGrid(deck, grid) {
  const libraryId = deck.track?.libraryId;
  if (!libraryId || !grid || isDemo(libraryId)) return;
  clearTimeout(persistTimers[deck.id]);
  persistTimers[deck.id] = setTimeout(() => {
    library.update(libraryId, {
      bpm: grid.bpm,
      beatOffset: grid.offset,
      bpmConfidence: grid.confidence,
      bpmSource: grid.source,
    });
  }, 250);
}

// Hot cues are saved with the track's metadata whenever they change (not when they are restored on load).
const cueTimers = {};
function persistHotCues(deck) {
  const libraryId = deck.track?.libraryId;
  if (!libraryId) return;
  const hotCues = deck.hotCues.slice();
  clearTimeout(cueTimers[deck.id]);
  cueTimers[deck.id] = setTimeout(() => saveMeta(libraryId, { hotCues }), 150);
}

// ---- SYNC ---------------------------------------------------------------------------------

function updateSyncButtons() {
  const ready = engine.decks.A?.grid && engine.decks.B?.grid;
  for (const v of Object.values(deckViews)) v.setSyncAvailable(!!ready);
}

function syncDeck(id) {
  const me = engine.decks[id];
  const him = engine.decks[other(id)];
  if (!me || !him || !me.loaded || !him.loaded) {
    toast('SYNC needs a track on both decks.', { kind: 'warn' });
    return;
  }
  if (me.analyzing || him.analyzing) {
    toast('Still analysing the tempo. Try again in a moment.', { kind: 'warn' });
    return;
  }
  if (!me.grid || !him.grid) {
    toast('Sync needs a BPM on both decks. Use Tap to set a missing one.', { kind: 'warn' });
    return;
  }
  const unsure = [me, him].filter((d) => d.grid.confidence < LOW_CONFIDENCE).map((d) => d.id);
  if (unsure.length) {
    toast(`The BPM on deck ${unsure.join(' and ')} is a low-confidence guess, so the sync may be off. Check it with Tap.`, {
      kind: 'warn',
      ms: 6000,
    });
  }
  const plan = planSync({ thisBase: me.grid.bpm, otherEff: him.effectiveBpm, range: me.pitchRange });
  if (!plan.ok) {
    toast(`Can't sync deck ${id}: it would need ${plan.pitch.toFixed(1)}% pitch, beyond ±16%.`, { kind: 'warn' });
    return;
  }
  if (plan.range !== me.pitchRange && me.setPitchRange(plan.range)) {
    toast(`Deck ${id} pitch range widened to ±${plan.range}% to reach ${him.effectiveBpm.toFixed(1)} BPM.`);
  }
  me.setPitch(plan.pitch);
  if (me.grabbed) {
    // The hand wins: the tempo is matched now, the beat alignment runs once after the record is let go.
    pendingAlign[id] = { track: me.track, ratio: plan.ratio };
    toast(`Deck ${id} synced to ${him.effectiveBpm.toFixed(1)} BPM. Beats align when you let go.`);
    return;
  }
  delete pendingAlign[id];
  alignPhase(me, him, plan.ratio);
  toast(`Deck ${id} synced to ${him.effectiveBpm.toFixed(1)} BPM`);
}

/** Land on the other deck's beat phase with a short seek (the worklet's fade adds SEEK_LATENCY). Only when both decks play. */
function alignPhase(me, him, ratio) {
  if (!(me.playing && him.playing && me.grid && him.grid) || me.grabbed) return;
  const delta = phaseAlignDelta({
    thisPos: me.position,
    thisGrid: me.grid,
    otherPos: him.position,
    otherGrid: him.grid,
    ratio,
  });
  me.seek(me.position + delta + SEEK_LATENCY * me.rate);
}

// SYNC pressed while a record was in a hand: align once the hand lets go and the motor has spun back up.
const pendingAlign = {};
const SPIN_UP_WAIT_MS = 200;
function onGrabChange(deck, e) {
  if (e.detail.grabbed) return;
  const job = pendingAlign[deck.id];
  if (!job) return;
  delete pendingAlign[deck.id];
  if (e.detail.reason === 'load') return; // a new track: the sync is moot
  setTimeout(() => {
    if (deck.track !== job.track || deck.grabbed || pendingAlign[deck.id]) return;
    const him = engine.decks[other(deck.id)];
    if (him && him.loaded) alignPhase(deck, him, job.ratio);
  }, SPIN_UP_WAIT_MS);
}

// ---- views --------------------------------------------------------------------------------

const deckViews = {
  A: createDeckView($('deck-a'), { id: 'A', onLoadClick: () => openLibrary('A'), onSync: () => syncDeck('A'), notify: toast }),
  B: createDeckView($('deck-b'), { id: 'B', onLoadClick: () => openLibrary('B'), onSync: () => syncDeck('B'), notify: toast }),
};

const libraryView = createLibraryView($('library'), {
  onAdd: (deck) => pickFiles(deck),
  onDismissStorageNotice: () => {
    try {
      localStorage.setItem(STORAGE_NOTICE_KEY, '1');
    } catch {
      /* it may show again next time: fine */
    }
  },
  onSplitCue: (on) => {
    if (on && engine.ctx && !engine.splitSupported) {
      toast('This device has a mono audio output, so split cue is not available.', { kind: 'warn', ms: 5000 });
      return false;
    }
    mixer.split = on;
    writeSplitSetting(on);
    engine.setSplitCue(on);
    mixerView.setSplitCue(on);
    return true;
  },
  onLoad: async (id, deckId) => {
    if (isDemo(id)) {
      const item = demoItems().find((t) => t.id === id);
      if (item) loadIntoDeck(deckId, demoProducer(id), item);
      return;
    }
    const blob = await library.getBlob(id);
    const item = (await library.list()).find((t) => t.id === id);
    if (!blob || !item) {
      toast("That track's data is no longer available.", { kind: 'error' });
      await refreshLibrary();
      return;
    }
    loadIntoDeck(deckId, blob, item);
  },
  onDelete: async (id) => {
    await library.remove(id);
    await refreshLibrary();
  },
});

async function refreshLibrary() {
  const items = await library.list();
  const hasUser = items.length > 0;
  libraryView.render([...demoItems(), ...items], {
    persistent: library.persistent,
    storageNotice: hasUser && shouldShowStorageNotice({ status: library.persistence, dismissed: storageNoticeDismissed() }),
    usage: library.persistent && hasUser ? await readEstimate() : null,
  });
}

const STORAGE_NOTICE_KEY = 'dj-mobile.storageNoticeSeen';
function storageNoticeDismissed() {
  try {
    return localStorage.getItem(STORAGE_NOTICE_KEY) === '1';
  } catch {
    return false;
  }
}
library.onPersistence = () => refreshLibrary();
showSplit(); // the saved split-cue choice (applied to the audio once the engine starts)

function openLibrary(deck = null) {
  refreshLibrary();
  libraryView.open(deck);
}
$('btn-library').addEventListener('click', () => openLibrary());
mixerView.libButton.addEventListener('click', () => openLibrary());

// Master volume lives in the settings sheet (the mixer column has no room for it).
const masterFader = createFader({
  label: 'Master volume',
  orientation: 'horizontal',
  value: FADER_UNITY,
  defaultValue: FADER_UNITY,
  caption: false,
  endLabels: ['−', '+'],
  onInput: (v) => {
    mixer.master = v;
    engine.setMaster(v);
  },
});
libraryView.masterSlot.appendChild(masterFader.el);

// ---- audio unlock overlay -----------------------------------------------------------------

const overlay = $('start-overlay');
const startBtn = $('start-btn');
const startMsg = $('start-msg');
const startTitle = $('start-title');
let started = false; // an engine has been started at least once
let wired = false; // the CURRENT engine's decks are attached to the views
let restore = null; // what to put back after the system closed the audio engine
const wake = createWakeLock();
const anyPlaying = () => Object.values(engine.decks).some((d) => d.playing);
const updateWake = () => {
  const playing = anyPlaying();
  wake.update(playing); // the screen stays on while playing
  engine.setPlaying(playing); // iOS silent-switch loop runs only while playing
};

function showOverlay(mode, message) {
  overlay.hidden = false;
  overlay.dataset.mode = mode;
  startBtn.hidden = mode === 'unsupported';
  startBtn.disabled = mode === 'busy';
  startTitle.textContent =
    mode === 'unsupported' ? 'Audio not available' : mode === 'resume' ? 'Audio paused' : mode === 'restart' ? 'Audio was reset' : 'DJ Mobile';
  startBtn.textContent = mode === 'busy' ? 'Starting…' : mode === 'resume' ? 'Tap to resume' : mode === 'restart' ? 'Tap to restart' : 'Tap to start';
  startMsg.textContent = message || '';
}

/** Attach the (new) engine's decks to the views and listen for its state changes. */
function wireEngine() {
  for (const id of ['A', 'B']) {
    const deck = engine.decks[id];
    deckViews[id].attach(deck);
    deck.addEventListener('error', (e) => toast(e.detail.message, { kind: 'error' }));
    deck.addEventListener('grab', (e) => onGrabChange(deck, e));
    deck.addEventListener('hotcues', (e) => {
      if (e.detail.persist) persistHotCues(deck);
    });
    deck.addEventListener('loop', (e) => {
      if (e.detail.reason === 'scratch') toast(`Loop on deck ${deck.id} ended: you let go outside it.`, { ms: 3000 });
    });
    deck.addEventListener('grid', (e) => {
      updateSyncButtons();
      if (e.detail.persist) persistGrid(deck, e.detail.grid);
    });
    deck.addEventListener('playstate', updateWake);
    deck.addEventListener('track', (e) => {
      if (!e.detail.track) cancelAnalysis(deck.id); // a paused deck was emptied to free memory for the next load
    });
  }
  applyMixer();
  engine.addEventListener('blocked', () => {
    releaseAllGrabs('blocked');
    showOverlay('resume', 'Tap to bring the sound back.');
  });
  engine.addEventListener('running', () => {
    overlay.hidden = true;
  });
  // The system closed the audio context (iOS may after a long interruption). A closed context cannot be
  // reopened and the samples inside its decks are gone, so: remember what was loaded, build a fresh engine on the
  // next tap (a gesture is required anyway) and reload those tracks from the library, paused at their old position.
  engine.addEventListener('closed', () => {
    restore = snapshotDecks(engine);
    releaseAllGrabs('closed');
    for (const id of ['A', 'B']) cancelAnalysis(id);
    wake.update(false);
    engine = new Engine();
    engine.splitCue = mixer.split;
    wired = false;
    showOverlay(
      'restart',
      restore.A || restore.B
        ? 'The system reset the audio engine. Tap to restart; your tracks reload from the library.'
        : 'The system reset the audio engine. Tap to restart.',
    );
  });
}

function snapshotDecks(e) {
  const out = { A: null, B: null };
  for (const id of ['A', 'B']) {
    const d = e.decks[id];
    if (d && d.loaded && d.track.libraryId) {
      out[id] = { libraryId: d.track.libraryId, name: d.track.name, position: d.position, pitch: d.pitch, range: d.pitchRange };
    }
  }
  return out;
}

/** One deck after the other (so two big tracks are never decoded at once). */
async function restoreDecks(snap) {
  const eng = engine;
  // a deck the user loads something onto while the restore is still busy keeps what the user chose
  const startTokens = { A: eng.decks.A.loadToken, B: eng.decks.B.loadToken };
  const untouched = (id) => engine === eng && eng.decks[id].loadToken === startTokens[id];
  for (const id of ['A', 'B']) {
    const s = snap[id];
    if (!s || !untouched(id)) continue;
    const item = [...demoItems(), ...(await library.list())].find((t) => t.id === s.libraryId);
    const source = !item ? null : item.demo ? demoProducer(item.id) : await library.getBlob(item.id);
    if (!item || !source) {
      toast(`Couldn't reload "${s.name}" onto deck ${id}. Load it again from the library.`, { kind: 'warn', ms: 6000 });
      continue;
    }
    if (!untouched(id)) continue; // (the lookups above took a moment)
    await loadIntoDeck(id, source, item);
    const d = engine.decks[id];
    if (d && d.loaded && d.track.libraryId === s.libraryId) {
      if (s.range === 16) d.setPitchRange(16);
      d.setPitch(s.pitch);
      d.seek(s.position);
    }
  }
}

startBtn.addEventListener('click', async () => {
  showOverlay('busy');
  const res = await engine.start();
  if (!res.ok) {
    showOverlay(res.unsupported ? 'unsupported' : restore ? 'restart' : started ? 'resume' : 'start', res.reason);
    return;
  }
  if (!wired) {
    wired = true;
    started = true;
    wireEngine();
    if (restore) {
      const snap = restore;
      restore = null;
      restoreDecks(snap);
    }
  }
  if (engine.state === 'running') overlay.hidden = true;
  else showOverlay('resume', 'Tap to bring the sound back.');
});

// ---- offline support and updates ----------------------------------------------------------

const updateBar = $('update-bar');
const updateReload = $('update-reload');
const CONFIRM_WINDOW_MS = 4000;

/**
 * Show the update bar. While any deck is playing, a reload would cut the music, so the first tap only changes the
 * bar to "Reload stops playback. Tap again"; a second tap within a few seconds reloads.
 */
function showUpdateBar(text, go) {
  let armedUntil = 0;
  let timer = null;
  const reset = () => {
    clearTimeout(timer);
    armedUntil = 0;
    updateReload.textContent = text;
    updateReload.disabled = false;
  };
  reset();
  updateBar.hidden = false;
  updateReload.onclick = () => {
    if (anyPlaying() && Date.now() > armedUntil) {
      armedUntil = Date.now() + CONFIRM_WINDOW_MS;
      updateReload.textContent = 'Reload stops playback. Tap again';
      clearTimeout(timer);
      timer = setTimeout(reset, CONFIRM_WINDOW_MS);
      return;
    }
    updateReload.disabled = true;
    go();
  };
  $('update-later').onclick = () => {
    reset();
    updateBar.hidden = true;
  };
}

initPwa({
  onUpdateReady: (apply) => showUpdateBar('Update ready: tap to reload', apply),
  // another window already applied an update and this page is playing: finish it when the user says so
  onStaleControl: (reload) => showUpdateBar('Reload to finish updating', reload),
  isPlaying: anyPlaying,
});

showOverlay('start', 'Tap once to unlock audio on this device.');

// ---- performance surface: no scroll / zoom / selection / context menu ----------------------

const stage = $('perform');
stage.addEventListener('contextmenu', (e) => e.preventDefault());
stage.addEventListener('selectstart', (e) => e.preventDefault());
stage.addEventListener('dblclick', (e) => e.preventDefault());
// Single-finger drags may scroll the stacked portrait layout; two or more fingers never pinch-zoom.
stage.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault()); // Safari pinch
}
document.addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey) e.preventDefault(); // desktop pinch/zoom
  },
  { passive: false },
);

$('rotate-dismiss').addEventListener('click', () => {
  $('rotate-hint').hidden = true;
});

// ---- grab safety: a scratch never outlives its finger -------------------------------------
// Pointer capture covers pointerup / pointercancel / lostpointercapture inside the deck view; these
// cover the cases where the page itself loses the pointer (app switch, tab hidden, bfcache).

function releaseAllGrabs(reason) {
  for (const v of Object.values(deckViews)) v.releaseGrab(reason);
}
window.addEventListener('blur', () => releaseAllGrabs('blur'));
window.addEventListener('pagehide', () => releaseAllGrabs('pagehide'));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) releaseAllGrabs('hidden');
});

// ---- frame loop: one rAF drives both decks' readouts and canvases -------------------------

function frame() {
  deckViews.A.tick();
  deckViews.B.tick();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

library.init().then(refreshLibrary);
