// Calls every Hindsight/gbrain tool through the real MCP handler (src/mcp.ts,
// bundled for Node here) against fake HINDSIGHT/GBRAIN Fetchers, so no
// network or workerd is needed. Covers request shapes, gbrain's SSE reply,
// the isError path, the 100,000-character cap and the gbrain allowlist.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let tmpDir;
let getMcpHandler;
let buildConfig;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'mcp-server-backends-'));
  const outfile = join(tmpDir, 'mcp.mjs');
  buildConfig = JSON.parse(await readFile(resolve(packageRoot, 'test/fixtures/config.test.json'), 'utf8'));
  await build({
    entryPoints: [resolve(packageRoot, 'src/mcp.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    define: { __BUILD_CONFIG__: JSON.stringify(JSON.stringify(buildConfig)) },
    logLevel: 'silent',
  });
  ({ getMcpHandler } = await import(pathToFileURL(outfile).href));
});

after(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

/** A Fetcher that records every call and answers with `respond(url, init)`. */
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

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sse = (message) => new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
const gbrainReply = (text, isError) => sse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) } });

let nextId = 1;
/** Sends one JSON-RPC request to a fresh handler and returns the parsed JSON-RPC response. */
async function rpc(env, method, params) {
  const res = await getMcpHandler(env).fetch(
    new Request('https://mcp.test.example/slug/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    }),
    { authInfo: { token: 't', clientId: 'c', scopes: [], extra: { email: 'a@b.test' } } },
  );
  const text = await res.text();
  const data = text.split('\n').find((line) => line.startsWith('data:'));
  return JSON.parse(data ? data.slice(5) : text);
}

const callTool = async (env, name, args) => (await rpc(env, 'tools/call', { name, arguments: args })).result;

test('tools/list exposes only read tools: whoami, three hindsight, two gbrain, three hermes-chats and the two doer Effort tools', async () => {
  const env = { HINDSIGHT: fakeFetcher(() => json({})), GBRAIN: fakeFetcher(() => json({})), HERMES_CHATS: fakeFetcher(() => json({})) };
  const { result } = await rpc(env, 'tools/list', {});
  assert.deepEqual(
    result.tools.map((t) => t.name).sort(),
    [
      'effort_find',
      'effort_get',
      'gbrain_get_page',
      'gbrain_search',
      'hermes_chats_list_day',
      'hermes_chats_read_message',
      'hermes_chats_read_session',
      'hindsight_list_banks',
      'hindsight_recall',
      'hindsight_reflect',
      'whoami',
    ],
  );
});

test('hindsight_list_banks GETs the banks endpoint', async () => {
  const HINDSIGHT = fakeFetcher(() => json({ banks: [{ bank_id: 'a' }] }));
  const result = await callTool({ HINDSIGHT, GBRAIN: fakeFetcher(() => json({})) }, 'hindsight_list_banks', {});
  assert.equal(HINDSIGHT.calls[0].url, 'http://hindsight.ssint-main-ai.svc.k.famevans.win:8888/v1/default/banks');
  assert.equal(HINDSIGHT.calls[0].init.method, 'GET');
  assert.match(result.content[0].text, /bank_id/);
});

test('hindsight_recall posts the query with defaults and returns only the result texts', async () => {
  const HINDSIGHT = fakeFetcher(() => json({ results: [{ text: 'one', metadata: { big: 'x' } }, { text: 'two' }] }));
  const result = await callTool({ HINDSIGHT, GBRAIN: fakeFetcher(() => json({})) }, 'hindsight_recall', { bank: 'my bank', query: 'q' });
  assert.equal(HINDSIGHT.calls[0].url, 'http://hindsight.ssint-main-ai.svc.k.famevans.win:8888/v1/default/banks/my%20bank/memories/recall');
  assert.deepEqual(JSON.parse(HINDSIGHT.calls[0].init.body), { query: 'q', budget: 'mid', max_tokens: 4096 });
  assert.equal(result.content[0].text, 'one\n\ntwo');
});

test('hindsight_recall honors max_tokens', async () => {
  const HINDSIGHT = fakeFetcher(() => json({ results: [] }));
  await callTool({ HINDSIGHT, GBRAIN: fakeFetcher(() => json({})) }, 'hindsight_recall', { bank: 'b', query: 'q', max_tokens: 100 });
  assert.equal(JSON.parse(HINDSIGHT.calls[0].init.body).max_tokens, 100);
});

test('hindsight_reflect posts a low-budget reflect and returns the markdown', async () => {
  const HINDSIGHT = fakeFetcher(() => json({ text: '# Answer' }));
  const result = await callTool({ HINDSIGHT, GBRAIN: fakeFetcher(() => json({})) }, 'hindsight_reflect', { bank: 'b', query: 'why' });
  assert.ok(HINDSIGHT.calls[0].url.endsWith('/v1/default/banks/b/reflect'));
  assert.deepEqual(JSON.parse(HINDSIGHT.calls[0].init.body), { query: 'why', budget: 'low', max_tokens: 4096 });
  assert.equal(result.content[0].text, '# Answer');
});

test('a non-2xx Hindsight answer comes back as a tool error, not an exception', async () => {
  const HINDSIGHT = fakeFetcher(() => json({ detail: 'nope' }, 500));
  const result = await callTool({ HINDSIGHT, GBRAIN: fakeFetcher(() => json({})) }, 'hindsight_list_banks', {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /500/);
});

test('gbrain tools send the allowlisted tool name with the key and parse the SSE reply', async () => {
  for (const [tool, name, args] of [
    ['gbrain_search', 'search', { query: 'q', limit: 3 }],
    ['gbrain_get_page', 'get_page', { slug: 'a/b' }],
  ]) {
    const GBRAIN = fakeFetcher(() => gbrainReply(JSON.stringify({ ok: name })));
    const result = await callTool({ HINDSIGHT: fakeFetcher(() => json({})), GBRAIN }, tool, args);
    const call = GBRAIN.calls[0];
    assert.equal(call.url, 'http://gbrain.ssint-main-ai.svc.k.famevans.win:3131/mcp');
    assert.equal(call.init.headers.Authorization, `Bearer ${buildConfig.gbrainKey}`);
    assert.equal(call.init.headers.Accept, 'application/json, text/event-stream');
    const sent = JSON.parse(call.init.body);
    assert.equal(sent.method, 'tools/call');
    assert.equal(sent.params.name, name);
    assert.deepEqual(sent.params.arguments, args);
    assert.equal(result.content[0].text, JSON.stringify({ ok: name }));
  }
});

test('a gbrain isError result comes back as a tool error', async () => {
  const GBRAIN = fakeFetcher(() => gbrainReply('page not found', true));
  const result = await callTool({ HINDSIGHT: fakeFetcher(() => json({})), GBRAIN }, 'gbrain_get_page', { slug: 'x' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /page not found/);
});

test('a non-2xx gbrain answer comes back as a tool error', async () => {
  const GBRAIN = fakeFetcher(() => new Response('no', { status: 406 }));
  const result = await callTool({ HINDSIGHT: fakeFetcher(() => json({})), GBRAIN }, 'gbrain_search', { query: 'q' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /406/);
});

test('output over 100,000 characters is truncated with a note', async () => {
  const GBRAIN = fakeFetcher(() => gbrainReply('x'.repeat(150_000)));
  const result = await callTool({ HINDSIGHT: fakeFetcher(() => json({})), GBRAIN }, 'gbrain_get_page', { slug: 'big' });
  const text = result.content[0].text;
  assert.ok(text.startsWith('x'.repeat(100_000)));
  assert.match(text.slice(100_000), /\[truncated/);
  assert.ok(text.length < 100_200);
});

test('a gbrain tool outside the allowlist cannot be called', async () => {
  const GBRAIN = fakeFetcher(() => gbrainReply('{}'));
  const response = await rpc({ HINDSIGHT: fakeFetcher(() => json({})), GBRAIN }, 'tools/call', { name: 'delete_page', arguments: { slug: 'x' } });
  assert.equal(GBRAIN.calls.length, 0);
  assert.ok(response.error || response.result?.isError);
});

test('the write tools are gone: retain and put_page reach neither backend', async () => {
  for (const name of ['hindsight_retain', 'gbrain_put_page']) {
    const HINDSIGHT = fakeFetcher(() => json({}));
    const GBRAIN = fakeFetcher(() => gbrainReply('{}'));
    const response = await rpc({ HINDSIGHT, GBRAIN }, 'tools/call', { name, arguments: { bank: 'b', content: 'x', slug: 'x' } });
    assert.equal(HINDSIGHT.calls.length + GBRAIN.calls.length, 0);
    assert.ok(response.error || response.result?.isError);
  }
});

// hermes-chats: read-only GETs against /days, /sessions and /messages.
const HC = 'http://hermes-chats.ssint-main-ai.svc.k.famevans.win:8080';
const hcEnv = (HERMES_CHATS) => ({ HINDSIGHT: fakeFetcher(() => json({})), GBRAIN: fakeFetcher(() => json({})), HERMES_CHATS });

test('hermes_chats_list_day GETs /days/<date>', async () => {
  const HERMES_CHATS = fakeFetcher(() => json({ date: '2026-11-01', sessions: [{ session_id: 's1' }] }));
  const result = await callTool(hcEnv(HERMES_CHATS), 'hermes_chats_list_day', { date: '2026-11-01' });
  assert.equal(HERMES_CHATS.calls[0].url, `${HC}/days/2026-11-01`);
  assert.equal(HERMES_CHATS.calls[0].init.method, 'GET');
  assert.equal(JSON.parse(result.content[0].text).sessions[0].session_id, 's1');
});

test('hermes_chats_list_day rejects a malformed date without calling the backend', async () => {
  const HERMES_CHATS = fakeFetcher(() => json({}));
  const response = await rpc(hcEnv(HERMES_CHATS), 'tools/call', { name: 'hermes_chats_list_day', arguments: { date: '../notes' } });
  assert.equal(HERMES_CHATS.calls.length, 0);
  assert.ok(response.error || response.result?.isError);
});

const fakeSession = (n, headChars = 10) => ({
  session: { session_id: 'cron_1', title: 't', raw: { huge: 'x'.repeat(50_000) } },
  messages: Array.from({ length: n }, (_, i) => ({ msg_id: i + 1, role: 'assistant', content_head: 'c'.repeat(headChars) })),
});

test('hermes_chats_read_session pages through messages with next_offset and drops session.raw', async () => {
  const HERMES_CHATS = fakeFetcher(() => json(fakeSession(5)));
  const env = hcEnv(HERMES_CHATS);
  const first = JSON.parse((await callTool(env, 'hermes_chats_read_session', { session_id: 'cron_1/x', limit: 2 })).content[0].text);
  assert.equal(HERMES_CHATS.calls[0].url, `${HC}/sessions/cron_1%2Fx`);
  assert.equal(first.session.raw, undefined);
  assert.equal(first.session.title, 't');
  assert.deepEqual(first.messages.map((m) => m.msg_id), [1, 2]);
  assert.equal(first.total_messages, 5);
  assert.equal(first.next_offset, 2);
  const last = JSON.parse((await callTool(env, 'hermes_chats_read_session', { session_id: 'cron_1/x', offset: 4, limit: 2 })).content[0].text);
  assert.deepEqual(last.messages.map((m) => m.msg_id), [5]);
  assert.equal(last.next_offset, null);
});

test('hermes_chats_read_session refuses a limit over 200', async () => {
  const HERMES_CHATS = fakeFetcher(() => json(fakeSession(1)));
  const response = await rpc(hcEnv(HERMES_CHATS), 'tools/call', { name: 'hermes_chats_read_session', arguments: { session_id: 's', limit: 201 } });
  assert.equal(HERMES_CHATS.calls.length, 0);
  assert.ok(response.error || response.result?.isError);
});

test('hermes_chats_read_session stops a page early instead of truncating it', async () => {
  const HERMES_CHATS = fakeFetcher(() => json(fakeSession(200, 5_000)));
  const result = await callTool(hcEnv(HERMES_CHATS), 'hermes_chats_read_session', { session_id: 's', limit: 200 });
  const text = result.content[0].text;
  assert.ok(text.length <= 100_000);
  const page = JSON.parse(text);
  assert.ok(page.returned > 0 && page.returned < 200);
  assert.equal(page.next_offset, page.returned);
});

test('hermes_chats_read_message passes part, offset and limit and returns next_offset', async () => {
  const HERMES_CHATS = fakeFetcher(() => json({ session_id: 's', msg_id: 7, part: 'reasoning', total_length: 250_000, offset: 90_000, limit: 90_000, returned: 90_000, text: 'r' }));
  const result = await callTool(hcEnv(HERMES_CHATS), 'hermes_chats_read_message', { session_id: 's', msg_id: 7, part: 'reasoning', offset: 90_000 });
  assert.equal(HERMES_CHATS.calls[0].url, `${HC}/messages/s/7?part=reasoning&offset=90000&limit=90000`);
  assert.equal(HERMES_CHATS.calls[0].init.method, 'GET');
  assert.equal(JSON.parse(result.content[0].text).next_offset, 180_000);
});

test('hermes_chats_read_message gives next_offset null on the last page and refuses a limit over 90,000', async () => {
  const HERMES_CHATS = fakeFetcher(() => json({ total_length: 100, offset: 0, limit: 90_000, returned: 100, text: 'x' }));
  const env = hcEnv(HERMES_CHATS);
  const result = await callTool(env, 'hermes_chats_read_message', { session_id: 's', msg_id: 1 });
  assert.equal(JSON.parse(result.content[0].text).next_offset, null);
  const response = await rpc(env, 'tools/call', { name: 'hermes_chats_read_message', arguments: { session_id: 's', msg_id: 1, limit: 90_001 } });
  assert.equal(HERMES_CHATS.calls.length, 1);
  assert.ok(response.error || response.result?.isError);
});

test('a hermes-chats 404 comes back as a short not-found tool error', async () => {
  const HERMES_CHATS = fakeFetcher(() => json({ error: 'not found' }, 404));
  const result = await callTool(hcEnv(HERMES_CHATS), 'hermes_chats_read_session', { session_id: 'nope' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not found/);
});

test('no hermes-chats tool writes: a notes tool does not exist and every call so far was GET', async () => {
  const HERMES_CHATS = fakeFetcher(() => json({}));
  const response = await rpc(hcEnv(HERMES_CHATS), 'tools/call', { name: 'hermes_chats_add_note', arguments: { session_id: 's' } });
  assert.equal(HERMES_CHATS.calls.length, 0);
  assert.ok(response.error || response.result?.isError);
});
