/**
 * missingFiles-entry.js — bootstrap for the standalone MissingFilesDialog
 * window. Receives its entries via the 'child-window-init' message (sent by
 * windowManager.open() once this window finishes loading), then applies the
 * user's remap decision back to the main window via a single 'missingFiles'
 * child-window-message instead of a direct in-process callback.
 */
import { initI18n, t } from '../src/i18n.js';
import { MissingFilesDialog } from '../src/missingFilesDialog.js';
import { finishDetachedWindowInit } from './detachedWindowChrome.js';

window.api.childWindow.onInit(async ({ entries } = {}) => {
  try {
    await initI18n();
    new MissingFilesDialog(entries ?? [], {
      onApply: async (remap) => {
        await window.api.childWindow.send('missingFiles', remap);
        window.close();
      },
    }).open();
    finishDetachedWindowInit('missingFiles', t('missingFiles.title'));
  } catch (err) {
    console.error('[missingFiles-entry] init failed:', err);
    document.body.textContent = `Error: ${err.message ?? err}`;
  }
});
