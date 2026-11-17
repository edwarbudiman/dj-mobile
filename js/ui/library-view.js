// Library sheet: list of stored tracks with Load A / Load B / Delete, and "Add files".

import { formatBytes, formatDuration } from './format.js';

/**
 * @param {HTMLElement} root  the sheet element (outside the performance surface, so it can scroll)
 * @param {{onAdd:()=>void, onLoad:(id:string, deck:string)=>void, onDelete:(id:string)=>void}} h
 */
export function createLibraryView(root, h) {
  root.innerHTML = `
    <div class="sheet-panel" role="dialog" aria-modal="true" aria-label="Library">
      <header class="sheet-head">
        <h2>Library</h2>
        <button type="button" class="btn btn-add" data-role="add">Add files</button>
        <button type="button" class="btn btn-close" data-role="close" aria-label="Close library">✕</button>
      </header>
      <p class="sheet-note" data-role="note" hidden></p>
      <ul class="track-list" data-role="list"></ul>
      <p class="sheet-empty" data-role="empty">No tracks yet. Tap “Add files” to pick audio from your device.</p>
    </div>`;
  const $ = (r) => root.querySelector(`[data-role="${r}"]`);
  const list = $('list');
  const empty = $('empty');
  const note = $('note');

  const open = () => {
    root.hidden = false;
  };
  const close = () => {
    root.hidden = true;
  };
  $('add').addEventListener('click', h.onAdd);
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
    meta.textContent = `${formatDuration(item.duration)} · ${formatBytes(item.size)}${item.sessionOnly ? ' · session only' : ''}`;
    info.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'track-actions';
    for (const id of ['A', 'B']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn btn-sm deck-${id.toLowerCase()}`;
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
      del.textContent = 'Sure?';
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
    /** @param {object[]} items  @param {{persistent:boolean}} state */
    render(items, { persistent }) {
      list.replaceChildren(...items.map(row));
      empty.hidden = items.length > 0;
      note.hidden = persistent;
      note.textContent = persistent ? '' : 'Storage is unavailable: tracks are kept for this session only.';
    },
  };
}
