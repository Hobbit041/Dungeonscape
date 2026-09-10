// tests/webStatic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import webStaticModule from '../webStatic.js';
const { resolveWebClientPath } = webStaticModule;

const ROOT = path.join('/srv', 'web-client');

test('/ resolves to index.html under the root with html content type', () => {
  const r = resolveWebClientPath('/', ROOT);
  assert.deepEqual(r, {
    absPath: path.join(ROOT, 'index.html'),
    contentType: 'text/html; charset=utf-8',
  });
});

test('/index.html resolves the same absPath as /', () => {
  const r = resolveWebClientPath('/index.html', ROOT);
  assert.equal(r.absPath, path.join(ROOT, 'index.html'));
});

test('/app.js resolves under the root with JS content type', () => {
  const r = resolveWebClientPath('/app.js', ROOT);
  assert.deepEqual(r, {
    absPath: path.join(ROOT, 'app.js'),
    contentType: 'application/javascript; charset=utf-8',
  });
});

test('/src/ws.js resolves a nested path under the root', () => {
  const r = resolveWebClientPath('/src/ws.js', ROOT);
  assert.deepEqual(r, {
    absPath: path.join(ROOT, 'src', 'ws.js'),
    contentType: 'application/javascript; charset=utf-8',
  });
});

test('an unknown extension is refused', () => {
  assert.equal(resolveWebClientPath('/secrets.env', ROOT), null);
});

test('a path with no extension is refused', () => {
  assert.equal(resolveWebClientPath('/passwd', ROOT), null);
});

test('path traversal above the root is refused', () => {
  assert.equal(resolveWebClientPath('/../main.js', ROOT), null);
  assert.equal(resolveWebClientPath('/src/../../main.js', ROOT), null);
});
