// App bootstrap and wiring: engine <-> mixer/deck views <-> library.

import { Engine } from './audio/engine.js';
import { FADER_UNITY } from './audio/mixer-math.js';
import { Library } from './store/db.js';
import { createToaster } from './ui/toast.js';
import { createDeckView } from './ui/deck-view.js';
import { createMixerView } from './ui/mixer-view.js';
import { createLibraryView } from './ui/library-view.js';

const $ = (id) => document.getElementById(id);
const toast = createToaster($('toasts'));
const engine = new Engine();
const library = new Library({ notify: (m) => toast(m, { kind: 'warn', ms: 6000 }) });

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

createMixerView($('mixer'), {
  onEq: (id, band, v) => {
    mixer.decks[id][band] = v;
    engine.decks[id]?.setEq(band, v);
  },
  onVolume: (id, v) => {
    mixer.decks[id].volume = v;
    engine.decks[id]?.setVolume(v);
  },
  onMaster: (v) => {
    mixer.master = v;
    engine.setMaster(v);
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
  if (target) await loadIntoDeck(target, added[0].file, added[0].item);
  else toast(`Added ${added.length} track${added.length === 1 ? '' : 's'} to the library`);
}

async function loadIntoDeck(deckId, blob, item) {
  const deck = engine.decks[deckId];
  if (!deck) {
    toast('Start the audio engine first.', { kind: 'warn' });
    return;
  }
  const res = await deck.loadBlob(blob, { name: item.name, libraryId: item.id });
  if (res.superseded) return;
  if (!res.ok) {
    toast(`Couldn't load “${item.name}”: ${res.message}. The file may be corrupt or in a format this browser can't decode.`, {
      kind: 'error',
      ms: 7000,
    });
    return;
  }
  if (item.duration == null) {
    item.duration = res.duration;
    await library.update(item.id, { duration: res.duration });
    refreshLibrary();
  }
}

// ---- views --------------------------------------------------------------------------------

const deckViews = {
  A: createDeckView($('deck-a'), { id: 'A', onLoadClick: () => pickFiles('A') }),
  B: createDeckView($('deck-b'), { id: 'B', onLoadClick: () => pickFiles('B') }),
};

const libraryView = createLibraryView($('library'), {
  onAdd: () => pickFiles(null),
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

$('btn-library').addEventListener('click', () => {
  refreshLibrary();
  libraryView.open();
});

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
    deckViews.A.attach(engine.decks.A);
    deckViews.B.attach(engine.decks.B);
    for (const id of ['A', 'B']) {
      engine.decks[id].addEventListener('error', (e) => toast(e.detail.message, { kind: 'error' }));
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
stage.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
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

// ---- frame loop ---------------------------------------------------------------------------

function frame() {
  deckViews.A.tick();
  deckViews.B.tick();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

library.init().then(refreshLibrary);
