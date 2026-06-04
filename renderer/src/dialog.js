import { t } from './i18n.js';

function _makeDialog(message, buttons, title = '') {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.style.zIndex = '9500';

    const panel = document.createElement('div');
    panel.className = 'fx-panel settings-panel';
    panel.style.cssText = 'z-index:9501;max-width:420px;width:90%';

    const safeMsg = message
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');

    const btnHtml = buttons.map((b, i) =>
      `<button class="settings-btn" id="_dlgBtn${i}">${b.label}</button>`
    ).join('');

    panel.innerHTML = `
      <div class="fx-header settings-panel-header">
        <span>${title}</span>
        <button class="fx-close" id="_dlgClose">✕</button>
      </div>
      <div class="settings-panel-body">
        <div class="settings-section">
          <p class="settings-drop-hint settings-drop-hint-static" style="white-space:pre-wrap">${safeMsg}</p>
          <div class="settings-row" style="justify-content:flex-end;gap:8px;margin-top:12px">
            ${btnHtml}
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    document.body.appendChild(panel);

    panel.style.left = `${Math.round((window.innerWidth  - panel.offsetWidth)  / 2)}px`;
    panel.style.top  = `${Math.round((window.innerHeight - panel.offsetHeight) / 2)}px`;

    const close = (result) => {
      overlay.remove();
      panel.remove();
      resolve(result);
    };

    document.getElementById('_dlgClose')?.addEventListener('click', () => close(buttons[buttons.length - 1].value));
    buttons.forEach((b, i) => {
      document.getElementById(`_dlgBtn${i}`)?.addEventListener('click', () => close(b.value));
    });
  });
}

export function showConfirm(message) {
  return _makeDialog(message, [
    { label: t('dialog.ok'),     value: true  },
    { label: t('dialog.cancel'), value: false },
  ]);
}

export function showAlert(message) {
  return _makeDialog(message, [
    { label: t('dialog.ok'), value: undefined },
  ]);
}

export function showUpdateDialog(tag) {
  return _makeDialog(
    t('update.message', { version: tag }),
    [
      { label: t('update.download'), value: 'download' },
      { label: t('update.skip'),     value: 'skip'     },
      { label: t('update.dismiss'),  value: 'dismiss'  },
    ],
    t('update.title')
  );
}
