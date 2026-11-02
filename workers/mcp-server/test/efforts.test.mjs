// Effort tools: role from the OAuth client id, role-gated tools/list, forwarding
// to the right upstream path with unchanged arguments, error mapping, and the
// generator's refusal of a PENDING effortsServiceId. No network or workerd.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLAUDE_AI = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const EFFORTS = 'http://efforts.ssint-main-efforts.svc.k.famevans.win:8080';

let tmpDir;
let getMcpHandler;
let roleForClientId;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'mcp-server-efforts-'));
  const buildConfig = await readFile(resolve(packageRoot, 'test/fixtures/config.test.json'), 'utf8');
  const bundle = async (entry, name) => {
    const outfile = join(tmpDir, name);
    await build({
      entryPoints: [resolve(packageRoot, entry)],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile,
      define: { __BUILD_CONFIG__: JSON.stringify(JSON.stringify(JSON.parse(buildConfig))) },
      logLevel: 'silent',
    });
    return import(pathToFileURL(outfile).href);
  };
  ({ getMcpHandler } = await bundle('src/mcp.ts', 'mcp.mjs'));
  ({ roleForClientId } = await bundle('src/efforts.ts', 'efforts.mjs'));
});

after(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

function fakeFetcher(respond) {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url: String(url), init });
      return respond(String(url), init);
    },
  };
}
const none = () => new Response('{}');
const env = (EFFORTS) => ({ HINDSIGHT: fakeFetcher(none), GBRAIN: fakeFetcher(none), HERMES_CHATS: fakeFetcher(none), EFFORTS });
const reply = (text, isError) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) } }), {
    headers: { 'Content-Type': 'application/json' },
  });

let nextId = 1;
async function rpc(e, role, method, params) {
  const res = await getMcpHandler(e, role).fetch(
    new Request('https://mcp.test.example/slug/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    }),
    { authInfo: { token: 't', clientId: role === 'coordinator' ? CLAUDE_AI : 'c', scopes: [], extra: { email: 'a@b.test' } } },
  );
  const text = await res.text();
  const data = text.split('\n').find((line) => line.startsWith('data:'));
  return JSON.parse(data ? data.slice(5) : text);
}
const toolNames = async (role) => (await rpc(env(fakeFetcher(none)), role, 'tools/list', {})).result.tools.map((t) => t.name).filter((n) => n.startsWith('effort_')).sort();

test('role: only the exact claude.ai client id is a coordinator', () => {
  assert.equal(roleForClientId(CLAUDE_AI), 'coordinator');
  for (const id of ['', undefined, 'c', `${CLAUDE_AI}/`, 'https://claude.ai/oauth/mcp-oauth-client-metadata2', 'HTTPS://claude.ai/oauth/mcp-oauth-client-metadata']) {
    assert.equal(roleForClientId(id), 'doer');
  }
});

test('tools/list: a doer sees only effort_find and effort_get', async () => {
  assert.deepEqual(await toolNames('doer'), ['effort_find', 'effort_get']);
});

test('tools/list: a coordinator sees all seven Effort tools', async () => {
  assert.deepEqual(await toolNames('coordinator'), [
    'effort_create', 'effort_depend', 'effort_find', 'effort_get', 'effort_release', 'effort_select', 'effort_update',
  ]);
});

test('a doer cannot call a write tool: nothing reaches the upstream', async () => {
  const EF = fakeFetcher(() => reply('{}'));
  const response = await rpc(env(EF), 'doer', 'tools/call', { name: 'effort_update', arguments: { ref: '1', session: 's' } });
  assert.equal(EF.calls.length, 0);
  assert.ok(response.error || response.result?.isError);
});

test('doer calls go to /mcp/doer with unchanged arguments', async () => {
  const EF = fakeFetcher(() => reply('found it'));
  const args = { why: 'w', what: 'x' };
  const response = await rpc(env(EF), 'doer', 'tools/call', { name: 'effort_find', arguments: args });
  assert.equal(EF.calls[0].url, `${EFFORTS}/mcp/doer`);
  assert.equal(EF.calls[0].init.method, 'POST');
  const sent = JSON.parse(EF.calls[0].init.body);
  assert.equal(sent.method, 'tools/call');
  assert.equal(sent.params.name, 'effort_find');
  assert.deepEqual(sent.params.arguments, args);
  assert.equal(response.result.content[0].text, 'found it');
});

test('coordinator calls go to /mcp/coordinator with unchanged arguments, SSE replies parsed', async () => {
  const args = { ref: '12', session: 'thread-1', status: 'Doing', add_fact: { text: 't', evidence: 'e' }, resolve_gap: { id: 'G1' } };
  const EF = fakeFetcher(() => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }));
  const response = await rpc(env(EF), 'coordinator', 'tools/call', { name: 'effort_update', arguments: args });
  assert.equal(EF.calls[0].url, `${EFFORTS}/mcp/coordinator`);
  assert.deepEqual(JSON.parse(EF.calls[0].init.body).params, { name: 'effort_update', arguments: args });
  assert.equal(response.result.content[0].text, 'ok');
  await rpc(env(EF), 'coordinator', 'tools/call', { name: 'effort_get', arguments: { ref: '1' } });
  assert.equal(EF.calls[1].url, `${EFFORTS}/mcp/coordinator`);
});

test('upstream failures come back as error results', async () => {
  for (const [respond, pattern] of [
    [() => reply('no such effort', true), /no such effort/],
    [() => new Response('x', { status: 502 }), /502/],
    [() => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad args' } })), /bad args/],
    [() => { throw new Error('down'); }, /unreachable/],
  ]) {
    const response = await rpc(env(fakeFetcher(respond)), 'doer', 'tools/call', { name: 'effort_get', arguments: { ref: '1' } });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, pattern);
  }
});

test('generator refuses a PENDING effortsServiceId', async () => {
  const { generateWorkerScript } = await import(pathToFileURL(resolve(packageRoot, 'scripts/generate-worker-script.mjs')).href);
  const config = JSON.parse(await readFile(resolve(packageRoot, 'test/fixtures/config.test.json'), 'utf8'));
  const bundlePath = join(tmpDir, 'bundle.js');
  await writeFile(bundlePath, 'export default {};');
  const run = async (cfg, name) => {
    const configPath = join(tmpDir, name);
    await writeFile(configPath, JSON.stringify(cfg));
    return generateWorkerScript({ bundle: bundlePath, config: configPath, out: join(tmpDir, 'out.yaml') });
  };
  await assert.rejects(run({ ...config, effortsServiceId: 'PENDING' }, 'pending.json'), /effortsServiceId/);
  const out = await run(config, 'ok.json');
  assert.match(await readFile(out, 'utf8'), /name: EFFORTS\n\s+type: vpc_service\n\s+serviceId: "test-efforts-service-id"/);
});
