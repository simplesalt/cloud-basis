// Exercises the BUILT bundle (a fresh bundle from test/fixtures/config.test.json,
// never the committed 30-mcp/worker-script.yaml's bundle) under workerd via
// miniflare, with fake bindings standing in for the real secrets/KV. Asserts
// the auth-only Indicators from simplesalt/projects#594 T2: the 401
// challenge, the two discovery documents, the 404 behavior, and the
// api.simplesalt.company signpost redirect.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Miniflare } from 'miniflare';

import { bundle } from '../scripts/bundle.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Must match test/fixtures/config.test.json's "host".
const HOST = 'mcp.test.example';
// A fake 32-hex slug, shaped like the real one but never a real secret.
const SLUG = '0123456789abcdef0123456789abcdef';
// Fixed fact, not from config.json — see src/config.ts.
const API_SIGNPOST_HOST = 'api.simplesalt.company';

let mf;
let tmpDir;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'mcp-server-smoke-'));
  const scriptPath = join(tmpDir, 'worker.test.js');

  await bundle({
    config: resolve(packageRoot, 'test/fixtures/config.test.json'),
    out: scriptPath,
    entry: resolve(packageRoot, 'src/index.ts'),
  });

  mf = new Miniflare({
    modules: true,
    scriptPath,
    // Comfortably within the pinned miniflare/workerd release's supported
    // range and >= 2024-11-11 (CIMD's `cache`-option requirement).
    compatibilityDate: '2026-06-01',
    compatibilityFlags: ['global_fetch_strictly_public'],
    kvNamespaces: ['OAUTH_KV'],
    bindings: {
      ACCESS_CLIENT_SECRET: 'test-access-client-secret',
      COOKIE_ENCRYPTION_KEY: 'a-cookie-encryption-key-at-least-32-characters',
      MCP_SLUG: SLUG,
    },
  });
  await mf.ready;
});

after(async () => {
  await mf?.dispose();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

/**
 * dispatchFetch always connects to the local workerd port, but forwards the
 * hostname from `url` as the request's Host — the same mechanism a real
 * Workers Route uses to pick a Worker, so this exercises the Worker's own
 * `new URL(request.url).hostname` checks (src/index.ts, src/mcp: none).
 */
function fetchAs(hostname, path, init) {
  return mf.dispatchFetch(`https://${hostname}${path}`, init);
}

test('unauthenticated POST to /<slug>/mcp gets a 401 with a resource_metadata challenge', async () => {
  const res = await fetchAs(HOST, `/${SLUG}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
  });
  assert.equal(res.status, 401);
  const challenge = res.headers.get('WWW-Authenticate');
  assert.ok(challenge, 'expected a WWW-Authenticate header');
  const match = challenge.match(/resource_metadata="([^"]+)"/);
  assert.ok(match, `expected resource_metadata in challenge, got: ${challenge}`);
  assert.equal(match[1], `https://${HOST}/.well-known/oauth-protected-resource/${SLUG}/mcp`);
});

test('protected resource metadata "resource" matches the MCP URL exactly', async () => {
  const res = await fetchAs(HOST, `/.well-known/oauth-protected-resource/${SLUG}/mcp`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.resource, `https://${HOST}/${SLUG}/mcp`);
  assert.deepEqual(body.authorization_servers, [`https://${HOST}`]);
});

test('authorization server metadata advertises CIMD, a registration endpoint, S256 and "none"', async () => {
  const res = await fetchAs(HOST, '/.well-known/oauth-authorization-server');
  assert.equal(res.status, 200);
  const meta = await res.json();
  assert.equal(meta.issuer, `https://${HOST}`);
  assert.equal(meta.client_id_metadata_document_supported, true);
  assert.equal(typeof meta.registration_endpoint, 'string');
  assert.ok(meta.code_challenge_methods_supported?.includes('S256'));
  assert.ok(meta.token_endpoint_auth_methods_supported?.includes('none'));
});

test('a wrong path under the real host 404s without revealing the slug', async () => {
  const res = await fetchAs(HOST, '/wrong/mcp');
  assert.equal(res.status, 404);
  const body = await res.text();
  assert.doesNotMatch(body, new RegExp(SLUG));
});

test('the bare root 404s without revealing the slug', async () => {
  const res = await fetchAs(HOST, '/');
  assert.equal(res.status, 404);
  const body = await res.text();
  assert.doesNotMatch(body, new RegExp(SLUG));
});

test('api.simplesalt.company signposts the real host with a 308, preserving path and query', async () => {
  const res = await fetchAs(API_SIGNPOST_HOST, `/${SLUG}/mcp?x=1`, { redirect: 'manual' });
  assert.equal(res.status, 308);
  assert.equal(res.headers.get('Location'), `https://${HOST}/${SLUG}/mcp?x=1`);
});

test('api.simplesalt.company 404s off-slug, without revealing the slug', async () => {
  const res = await fetchAs(API_SIGNPOST_HOST, '/other');
  assert.equal(res.status, 404);
  const body = await res.text();
  assert.doesNotMatch(body, new RegExp(SLUG));
});
