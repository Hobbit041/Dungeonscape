/**
 * webStatic.js — resolves an HTTP pathname to a file under the web-client
 * static root, or null if it isn't servable. Pure/side-effect-free so it's
 * unit-testable without an HTTP server (see tests/webStatic.test.mjs);
 * main.js does the actual fs.readFileSync + response writing.
 */
const path = require('path');

const EXT_CONTENT_TYPE = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
};

function resolveWebClientPath(pathname, webClientRoot) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const ext = path.extname(rel).toLowerCase();
  const contentType = EXT_CONTENT_TYPE[ext];
  if (!contentType) return null;

  const abs = path.join(webClientRoot, rel);
  const normalizedRoot = webClientRoot.endsWith(path.sep) ? webClientRoot : webClientRoot + path.sep;
  if (!abs.startsWith(normalizedRoot)) return null; // path traversal guard

  return { absPath: abs, contentType };
}

module.exports = { resolveWebClientPath };
