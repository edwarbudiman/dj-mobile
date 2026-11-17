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

const $ = (id) => document.getElementById(id);
const toast = createToaster($('toasts'));
const engine = new Engine();
const library = new Library({ notify: (m) => toast(m, { kind: 'warn', ms: 6000 }) });
const tempo = new TempoAnalyzer();
const other = (id) => (id === 'A' ? 'B' : 'A');

// ---- mixer state (UI is the source of truth; pushed to the engine once it exists) ---------

const mixer = {
  master: FADER_UNITY,
  crossfader: 0.5,
  decks: {
    A: { volume: FADER_UNITY, high: FADER_UNITY, mid: FADER_UNITY, low: FADER_UNITY },
    B: { volume: FADER_UNITY, high: FADER_UNITY, mid: FADER_UNITY, low: FADER_UNITY },
  },
};

function applyMixer() {
  engine.setMaster(mixer.master);
  engine.setCrossfader(mixer.crossfader);
  for (const [id, s] of Object.entries(mixer.decks)) {
    const deck = engine.decks[id];
    if (!deck) continue;
    deck.setVolume(s.volume);
    deck.setEq('high', s.high);
    deck.setEq('mid', s.mid);
    deck.setEq('low', s.low);
  }
}

const mixerView = createMixerView($('mixer'), {
  onEq: (id, band, v) => {
    mixer.decks[id][band] = v;
    engine.decks[id]?.setEq(band, v);
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

async function loadIntoDeck(deckId, blob, item) {
  const deck = engine.decks[deckId];
  if (!deck) {
    toast('Start the audio engine first.', { kind: 'warn' });
    return;
  }
  // A track reloaded from the library reuses its stored tempo instead of re-analysing.
  const stored = item.bpm > 0 && Number.isFinite(item.beatOffset);
  const res = await deck.loadBlob(blob, { name: item.name, libraryId: item.id }, {
    beforeTransfer: (channels, ctl) => prepareTrack(channels, { needBpm: !stored }, () => !ctl.isCurrent()),
  });
  if (res.superseded) return;
  if (!res.ok) {
    toast(`Couldn't load “${item.name}”: ${res.message}. The file may be corrupt or in a format this browser can't decode.`, {
      kind: 'error',
      ms: 7000,
    });
    return; // the old track stays loaded, and its analysis keeps running untouched
  }
  cancelAnalysis(deckId); // only now is the previous track's analysis obsolete
  deckViews[deckId].setPeaks(res.prepared.peaks);

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
  if (!libraryId || !grid) return;
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
  if (me.playing && him.playing) {
    // Land on the other deck's beat phase with a short seek (the worklet's fade adds SEEK_LATENCY).
    const delta = phaseAlignDelta({
      thisPos: me.position,
      thisGrid: me.grid,
      otherPos: him.position,
      otherGrid: him.grid,
      ratio: plan.ratio,
    });
    me.seek(me.position + delta + SEEK_LATENCY * me.rate);
  }
  toast(`Deck ${id} synced to ${him.effectiveBpm.toFixed(1)} BPM`);
}

// ---- views --------------------------------------------------------------------------------

const deckViews = {
  A: createDeckView($('deck-a'), { id: 'A', onLoadClick: () => openLibrary('A'), onSync: () => syncDeck('A'), notify: toast }),
  B: createDeckView($('deck-b'), { id: 'B', onLoadClick: () => openLibrary('B'), onSync: () => syncDeck('B'), notify: toast }),
};

const libraryView = createLibraryView($('library'), {
  onAdd: (deck) => pickFiles(deck),
  onLoad: async (id, deckId) => {
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
  libraryView.render(await library.list(), { persistent: library.persistent });
}

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
let started = false;

function showOverlay(mode, message) {
  overlay.hidden = false;
  overlay.dataset.mode = mode;
  startBtn.hidden = mode === 'unsupported';
  startBtn.disabled = mode === 'busy';
  startTitle.textContent = mode === 'unsupported' ? 'Audio not available' : mode === 'resume' ? 'Audio paused' : 'DJ Mobile';
  startBtn.textContent = mode === 'busy' ? 'Starting…' : mode === 'resume' ? 'Tap to resume' : 'Tap to start';
  startMsg.textContent = message || '';
}

startBtn.addEventListener('click', async () => {
  showOverlay('busy');
  const res = await engine.start();
  if (!res.ok) {
    showOverlay(res.unsupported ? 'unsupported' : started ? 'resume' : 'start', res.reason);
    return;
  }
  if (!started) {
    started = true;
    for (const id of ['A', 'B']) {
      const deck = engine.decks[id];
      deckViews[id].attach(deck);
      deck.addEventListener('error', (e) => toast(e.detail.message, { kind: 'error' }));
      deck.addEventListener('grid', (e) => {
        updateSyncButtons();
        if (e.detail.persist) persistGrid(deck, e.detail.grid);
      });
    }
    applyMixer();
    engine.addEventListener('blocked', () => showOverlay('resume', 'Tap to bring the sound back.'));
    engine.addEventListener('running', () => {
      overlay.hidden = true;
    });
  }
  if (engine.state === 'running') overlay.hidden = true;
  else showOverlay('resume', 'Tap to bring the sound back.');
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

// ---- frame loop: one rAF drives both decks' readouts and canvases -------------------------

function frame() {
  deckViews.A.tick();
  deckViews.B.tick();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

library.init().then(refreshLibrary);
