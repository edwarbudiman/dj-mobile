// A small confirm dialog in the app's own style (no window.confirm): the library sheet's panel, a message and
// two buttons. One question at a time; Escape, the Cancel button or a tap outside answers "no".

/**
 * @param {HTMLElement} root  the (hidden) .sheet element
 * @returns {{ask:(o:{title:string, message:string, detail?:string, confirmText?:string, cancelText?:string})=>Promise<boolean>}}
 */
export function createConfirm(root) {
  root.innerHTML = `
    <div class="sheet-panel" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message">
      <header class="sheet-head"><h2 id="confirm-title" data-role="title"></h2></header>
      <p class="confirm-body" id="confirm-message" data-role="message"></p>
      <p class="confirm-detail" data-role="detail" hidden></p>
      <div class="confirm-actions">
        <button type="button" class="btn" data-role="cancel">Cancel</button>
        <button type="button" class="btn btn-go" data-role="go">Load anyway</button>
      </div>
    </div>`;
  const $ = (r) => root.querySelector(`[data-role="${r}"]`);
  let settle = null;

  function close(answer) {
    root.hidden = true;
    const s = settle;
    settle = null;
    if (s) s(answer);
  }
  $('go').addEventListener('click', () => close(true));
  $('cancel').addEventListener('click', () => close(false));
  root.addEventListener('click', (e) => {
    if (e.target === root) close(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.hidden) close(false);
  });

  return {
    ask({ title, message, detail = '', confirmText = 'Load anyway', cancelText = 'Cancel' }) {
      if (settle) close(false); // a new question replaces an unanswered one
      $('title').textContent = title;
      $('message').textContent = message;
      $('detail').textContent = detail;
      $('detail').hidden = !detail;
      $('go').textContent = confirmText;
      $('cancel').textContent = cancelText;
      root.hidden = false;
      $('cancel').focus();
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
  };
}
