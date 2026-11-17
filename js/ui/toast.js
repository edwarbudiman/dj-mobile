// Minimal toast notifications. The container is an aria-live region. Toasts never take pointer
// events (CSS), so they cannot block the controls they float over; they dismiss by timeout.
// Durations are capped by kind so nothing lingers over the mixer: info 2.5 s, warnings 4 s, errors 5 s.

const MAX_MS = { info: 2500, warn: 4000, error: 5000 };

/** @param {HTMLElement} root */
export function createToaster(root) {
  return function toast(message, { kind = 'info', ms } = {}) {
    const cap = MAX_MS[kind] ?? MAX_MS.info;
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.textContent = message;
    root.appendChild(el);
    while (root.children.length > 3) root.firstChild.remove();
    setTimeout(() => el.remove(), Math.min(ms ?? cap, cap));
    return el;
  };
}
