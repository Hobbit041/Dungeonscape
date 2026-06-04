import { Storage }          from './storage.js';
import { showUpdateDialog } from './dialog.js';

const GITHUB_API    = 'https://api.github.com/repos/Hobbit041/SoundscapePortable/releases/latest';
const FETCH_TIMEOUT = 5000;

let _updateInfo = null;

function _parseVersion(v) {
  return v.replace(/^v/, '').split('.').map(Number);
}

function _isNewer(latestTag, currentVersion) {
  const l = _parseVersion(latestTag);
  const c = _parseVersion(currentVersion);
  for (let i = 0; i < 3; i++) {
    if ((l[i] || 0) > (c[i] || 0)) return true;
    if ((l[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
}

async function _fetchLatest() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(GITHUB_API, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.tag_name || !data.html_url) return null;
    return { tag: data.tag_name, url: data.html_url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Returns cached update info if a newer version was found, otherwise null. */
export function getUpdateInfo() {
  return _updateInfo;
}

/** Fire-and-forget: fetch latest release, compare, maybe show dialog. */
export async function checkForUpdates() {
  const currentVersion = await window.api.getAppVersion();
  const latest = await _fetchLatest();
  if (!latest || !_isNewer(latest.tag, currentVersion)) return;

  _updateInfo = latest;

  const skipped = await Storage.get('skippedVersion');
  if (skipped === latest.tag) return;

  const choice = await showUpdateDialog(latest.tag);
  if (choice === 'download') {
    await window.api.shell.openExternal(latest.url);
  } else if (choice === 'skip') {
    await Storage.set('skippedVersion', latest.tag);
  }
}
