// Cowork-facing tools for the two in-cluster backends, reached through
// Workers VPC service bindings (env.HINDSIGHT, env.GBRAIN; see
// 30-mcp/worker-script.yaml). Hindsight is plain REST with no auth; gbrain is
// a stateless JSON-RPC /mcp endpoint that always answers as SSE.
//
// Read-only: no tool here writes to either backend. gbrain lists ~116 tools
// and its key has admin scope, so only the two read tools in GBRAIN_TOOLS are
// exposed — never forward an arbitrary tool name.
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { BUILD_CONFIG } from './config';
import type { Env } from './env';

const HINDSIGHT_BASE = 'http://hindsight.ssint-main-ai.svc.k.famevans.win:8888';
const GBRAIN_URL = 'http://gbrain.ssint-main-ai.svc.k.famevans.win:3131/mcp';

/** Cap on the text any tool returns, so one answer cannot flood the caller's context. */
export const MAX_RESULT_CHARS = 100_000;

interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** Thrown for any backend failure; its message is the short text handed back as the tool error. */
class BackendError extends Error {}

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated: output exceeded ${MAX_RESULT_CHARS} characters]`;
}

/** Runs a tool body, turning text into a capped result and any BackendError into an MCP tool error. */
async function respond(body: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: truncate(await body()) }] };
  } catch (error) {
    if (!(error instanceof BackendError)) throw error;
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
}

async function hindsight(env: Env, method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await env.HINDSIGHT.fetch(`${HINDSIGHT_BASE}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new BackendError('Hindsight is unreachable.');
  }
  if (!res.ok) throw new BackendError(`Hindsight returned HTTP ${res.status}.`);
  return res.json();
}

/** Pulls the JSON-RPC message out of gbrain's SSE reply (`event: message` / `data: <JSON>`). */
function parseSse(text: string): { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } } {
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) return JSON.parse(line.slice(5).trim());
  }
  throw new BackendError('gbrain sent no data line.');
}

async function gbrain(env: Env, name: (typeof GBRAIN_TOOLS)[number], args: Record<string, unknown>): Promise<string> {
  let res: Response;
  try {
    res = await env.GBRAIN.fetch(GBRAIN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${BUILD_CONFIG.gbrainKey}`,
        'Content-Type': 'application/json',
        // gbrain answers 406 unless the client accepts both.
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
  } catch {
    throw new BackendError('gbrain is unreachable.');
  }
  if (!res.ok) throw new BackendError(`gbrain returned HTTP ${res.status}.`);
  let message: ReturnType<typeof parseSse>;
  try {
    message = parseSse(await res.text());
  } catch (error) {
    if (error instanceof BackendError) throw error;
    throw new BackendError('gbrain sent an unreadable reply.');
  }
  if (message.error) throw new BackendError(`gbrain error: ${message.error.message ?? 'unknown'}`);
  // Tool errors arrive as HTTP 200 with result.isError.
  const text = message.result?.content?.[0]?.text ?? '';
  if (message.result?.isError) throw new BackendError(`gbrain tool error: ${text.slice(0, 500)}`);
  return text;
}

/** The only gbrain tools this server will call. */
const GBRAIN_TOOLS = ['search', 'get_page'] as const;

export function registerBackendTools(server: McpServer, env: Env): void {
  server.registerTool(
    'hindsight_list_banks',
    {
      title: 'List Hindsight banks',
      description: 'Lists the memory banks available in Hindsight.',
      inputSchema: z.object({}),
    },
    () => respond(async () => JSON.stringify(await hindsight(env, 'GET', '/v1/default/banks'))),
  );

  server.registerTool(
    'hindsight_recall',
    {
      title: 'Recall from Hindsight',
      description: 'Searches a Hindsight memory bank and returns the matching memories as text.',
      inputSchema: z.object({
        bank: z.string().min(1),
        query: z.string().min(1),
        max_tokens: z.number().int().positive().optional(),
      }),
    },
    ({ bank, query, max_tokens }) =>
      respond(async () => {
        const data = (await hindsight(env, 'POST', `/v1/default/banks/${encodeURIComponent(bank)}/memories/recall`, {
          query,
          budget: 'mid',
          max_tokens: max_tokens ?? 4096,
        })) as { results?: { text?: string }[] };
        // Drop the bulky per-memory metadata; the text is what a caller reads.
        return (data.results ?? []).map((r) => r.text ?? '').join('\n\n');
      }),
  );

  server.registerTool(
    'hindsight_reflect',
    {
      title: 'Reflect with Hindsight',
      description: 'Asks Hindsight to reason over a memory bank and answer in markdown. Can take up to 25 seconds.',
      inputSchema: z.object({ bank: z.string().min(1), query: z.string().min(1) }),
    },
    ({ bank, query }) =>
      respond(async () => {
        const data = (await hindsight(env, 'POST', `/v1/default/banks/${encodeURIComponent(bank)}/reflect`, {
          query,
          budget: 'low',
          max_tokens: 4096,
        })) as { text?: string };
        return data.text ?? '';
      }),
  );

  server.registerTool(
    'gbrain_search',
    {
      title: 'Search gbrain',
      description: 'Searches the gbrain knowledge base.',
      inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().positive().optional() }),
    },
    ({ query, limit }) => respond(() => gbrain(env, 'search', { query, limit })),
  );

  server.registerTool(
    'gbrain_get_page',
    {
      title: 'Get a gbrain page',
      description: 'Fetches one gbrain page by slug.',
      inputSchema: z.object({ slug: z.string().min(1) }),
    },
    ({ slug }) => respond(() => gbrain(env, 'get_page', { slug })),
  );

}
