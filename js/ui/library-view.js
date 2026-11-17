// Library and settings sheet: stored tracks (Load A / Load B / Delete, Add files), master volume,
// pitch range. Lives outside the performance surface so the list can scroll.

import { formatBytes, formatDuration } from './format.js';

/**
 * @param {HTMLElement} root  the sheet element
 * @param {{onAdd:(deck:string|null)=>void, onLoad:(id:string, deck:string)=>void, onDelete:(id:string)=>void}} h
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
    name.textContent = item.name;
    const meta = document.createElement('div');
    meta.className = 'track-meta';
    const bits = [formatDuration(item.duration), formatBytes(item.size)];
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
    actions.appendChild(del);
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
    /** @param {object[]} items  @param {{persistent:boolean}} state */
    render(items, { persistent }) {
      list.replaceChildren(...items.map(row));
      empty.hidden = items.length > 0;
      note.hidden = persistent;
      note.textContent = persistent ? '' : 'Storage is unavailable here, so tracks are kept for this session only.';
    },
  };
}
