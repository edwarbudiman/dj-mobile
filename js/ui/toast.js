// Minimal toast notifications. The container is an aria-live region.

/** @param {HTMLElement} root */
export function createToaster(root) {
  return function toast(message, { kind = 'info', ms = 4000 } = {}) {
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.textContent = message;
    root.appendChild(el);
    while (root.children.length > 4) root.firstChild.remove();
    const remove = () => el.remove();
    el.addEventListener('pointerdown', remove);
    setTimeout(remove, ms);
    return el;
  };
}
