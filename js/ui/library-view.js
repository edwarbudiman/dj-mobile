// Library and settings sheet: stored tracks (Load A / Load B / Delete, Add files), master volume,
// pitch range. Lives outside the performance surface so the list can scroll.

import { formatBytes, formatDuration } from './format.js';

/**
 * @param {HTMLElement} root  the sheet element
 * @param {{onAdd:(deck:string|null)=>void, onLoad:(id:string, deck:string)=>void, onDelete:(id:string)=>void,
 *          onSplitCue:(on:boolean)=>boolean}} h  onSplitCue returns whether the change was accepted
 * Demo items ({demo:true}) are labelled DEMO and have no Delete button.
 */
export function createLibraryView(root, h) {
  root.innerHTML = `
    <div class="sheet-panel" role="dialog" aria-modal="true" aria-label="Library and settings">
      <header class="sheet-head">
        <h2 data-role="heading">Library</h2>
        <button type="button" class="btn btn-add" data-role="add">Add files</button>
        <button type="button" class="btn btn-close" data-role="close" aria-label="Close">Done</button>
      </header>
      <section class="settings" aria-label="Settings">
        <div class="setting"><span class="setting-name">Master volume</span><div class="setting-control" data-role="master-slot"></div></div>
        <div class="setting">
          <span class="setting-name">Split headphone cue</span>
          <div class="setting-control"><div class="seg" role="group" aria-label="Split headphone cue">
            <button type="button" class="btn" data-split="off" aria-pressed="true">Off</button>
            <button type="button" class="btn" data-split="on" aria-pressed="false">On</button>
          </div></div>
        </div>
        <p class="setting-note" data-role="split-note">Needs a stereo-to-dual-mono splitter (a "DJ splitter" cable): left channel to your headphones = cue, right channel to the speakers = master. A plain headphone Y splitter will not work.</p>
      </section>
      <p class="sheet-note" data-role="note" hidden></p>
      <ul class="track-list" data-role="list"></ul>
      <p class="sheet-empty" data-role="empty">No tracks yet. Choose Add files to pick audio from this device.</p>
    </div>`;
  const $ = (r) => root.querySelector(`[data-role="${r}"]`);
  const list = $('list');
  const empty = $('empty');
  const note = $('note');
  const heading = $('heading');
  let target = null; // deck this sheet was opened for

  const close = () => {
    root.hidden = true;
  };
  function open(deck = null) {
    target = deck;
    heading.textContent = deck ? `Load onto deck ${deck}` : 'Library';
    root.dataset.target = deck || '';
    root.hidden = false;
  }
  const splitBtns = [...root.querySelectorAll('[data-split]')];
  const splitNote = $('split-note');
  const SPLIT_NOTE = splitNote.textContent;
  function setSplit(on) {
    for (const b of splitBtns) b.setAttribute('aria-pressed', String((b.dataset.split === 'on') === on));
  }
  for (const b of splitBtns) {
    b.addEventListener('click', () => {
      const want = b.dataset.split === 'on';
      if (h.onSplitCue(want) !== false) setSplit(want);
    });
  }
  $('add').addEventListener('click', () => h.onAdd(target));
  $('close').addEventListener('click', close);
  root.addEventListener('click', (e) => {
    if (e.target === root) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.hidden) close();
  });
  function row(item) {
    const li = document.createElement('li');
    li.className = 'track';
    const info = document.createElement('div');
    info.className = 'track-info';
    const name = document.createElement('div');
    name.className = 'track-name';
    if (item.demo) {
      const tag = document.createElement('span');
      tag.className = 'demo-tag';
      tag.textContent = 'DEMO';
      name.append(tag);
    }
    name.append(item.name);
    const meta = document.createElement('div');
    meta.className = 'track-meta';
    const bits = item.demo ? ['Built-in loop', formatDuration(item.duration)] : [formatDuration(item.duration), formatBytes(item.size)];
    if (item.bpm > 0) bits.push(`${item.bpm.toFixed(1)} BPM`);
    if (item.sessionOnly) bits.push('this session only');
    meta.textContent = bits.join('  ');
    info.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'track-actions';
    for (const id of ['A', 'B']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn btn-sm deck-${id.toLowerCase()}${target === id ? ' target' : ''}`;
      b.textContent = `Load ${id}`;
      b.addEventListener('click', () => {
        h.onLoad(item.id, id);
        close();
      });
      actions.appendChild(b);
    }
    // Two-step delete instead of a blocking confirm() dialog.
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-sm btn-del';
    del.textContent = 'Delete';
    let armed = null;
    del.addEventListener('click', () => {
      if (armed) {
        clearTimeout(armed);
        h.onDelete(item.id);
        return;
      }
      del.textContent = 'Delete?';
      del.classList.add('armed');
      armed = setTimeout(() => {
        armed = null;
        del.textContent = 'Delete';
        del.classList.remove('armed');
      }, 3000);
    });
    if (!item.demo) actions.appendChild(del);
    li.append(info, actions);
    return li;
  }

  return {
    open,
    close,
    get isOpen() {
      return !root.hidden;
    },
    masterSlot: $('master-slot'),
    /** Reflect the split-cue state; supported:false (mono output) disables On and says why. */
    setSplitCue(on, { supported = true } = {}) {
      setSplit(on);
      splitBtns.find((b) => b.dataset.split === 'on').disabled = !supported;
      splitNote.dataset.warn = String(!supported);
      splitNote.textContent = supported ? SPLIT_NOTE : 'This device has a mono audio output, so split cue is not available.';
    },
    /** @param {object[]} items  @param {{persistent:boolean}} state */
    render(items, { persistent }) {
      list.replaceChildren(...items.map(row));
      empty.hidden = items.some((t) => !t.demo);
      note.hidden = persistent;
      note.textContent = persistent ? '' : 'Storage is unavailable here, so tracks are kept for this session only.';
    },
  };
}
