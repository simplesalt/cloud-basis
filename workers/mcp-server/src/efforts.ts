// Effort tools: thin forwards to the cluster-local Effort MCP server, reached
// through the EFFORTS Workers VPC service binding. Which tools a caller sees
// depends on its role, decided from the OAuth client id behind its token:
// coordinators get everything, doers only effort_find and effort_get. The
// MCP server instance is built per request with the role (see src/mcp.ts),
// so a doer's tools/list never contains the write tools at all.
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { BackendError, respond } from './backends';
import type { Env } from './env';

/** Host and port of the in-cluster Effort MCP server; change here only. */
export const EFFORTS_ORIGIN = 'http://efforts.ssint-main-efforts.svc.k.famevans.win:8080';

/** The OAuth client id claude.ai presents; the only client treated as a coordinator. */
export const COORDINATOR_CLIENT_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata';

export type Role = 'coordinator' | 'doer';

/** Coordinator iff the client id is exactly claude.ai's; everything else, including empty, is a doer. */
export function roleForClientId(clientId: string | undefined): Role {
  return clientId === COORDINATOR_CLIENT_ID ? 'coordinator' : 'doer';
}

/** The upstream MCP endpoint a role's calls go to. */
export function upstreamUrl(role: Role): string {
  return `${EFFORTS_ORIGIN}/mcp/${role}`;
}

interface UpstreamMessage {
  result?: { content?: { type?: string; text?: string }[]; isError?: boolean };
  error?: { message?: string };
}

/** Parses a JSON-RPC reply that is either plain JSON or SSE (`data: <JSON>` lines). */
function parseReply(text: string, contentType: string): UpstreamMessage {
  if (contentType.includes('text/event-stream') || text.trimStart().startsWith('event:') || text.trimStart().startsWith('data:')) {
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) return JSON.parse(line.slice(5).trim());
    }
    throw new BackendError('efforts sent no data line.');
  }
  return JSON.parse(text);
}

async function forward(env: Env, role: Role, name: string, args: Record<string, unknown>): Promise<string> {
  let res: Response;
  try {
    res = await env.EFFORTS.fetch(upstreamUrl(role), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
  } catch {
    throw new BackendError('The Effort server is unreachable.');
  }
  if (!res.ok) throw new BackendError(`The Effort server returned HTTP ${res.status}.`);
  let message: UpstreamMessage;
  try {
    message = parseReply(await res.text(), res.headers.get('Content-Type') ?? '');
  } catch (error) {
    if (error instanceof BackendError) throw error;
    throw new BackendError('The Effort server sent an unreadable reply.');
  }
  if (message.error) throw new BackendError(`Effort error: ${message.error.message ?? 'unknown'}`);
  const text = (message.result?.content ?? [])
    .filter((part) => part.type === undefined || part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
  if (message.result?.isError) throw new BackendError(`Effort tool error: ${text.slice(0, 500)}`);
  return text;
}

const idNote = z.object({ id: z.string(), note: z.string().optional() });
const session = z
  .string()
  .describe("A label identifying the calling thread, stored as the Effort's In Use holder.");

const FIND_GET = {
  effort_find: {
    title: 'Find an Effort',
    description: 'Finds the existing Effort that best matches a described why, what and where.',
    inputSchema: z.object({ why: z.string(), what: z.string().optional(), where: z.string().optional() }),
  },
  effort_get: {
    title: 'Get an Effort',
    description: 'Returns one Effort in full (why, what, where, how, status).',
    inputSchema: z.object({ ref: z.string() }),
  },
};

const COORDINATOR_ONLY = {
  effort_create: {
    title: 'Create an Effort',
    description: 'Creates a new Effort with its why, what, where and optional gaps, facts, unknowns and tasks.',
    inputSchema: z.object({
      title: z.string(),
      type: z.enum(['Feature', 'Bug', 'Analysis', 'Advisory']),
      assigned: z.string(),
      why: z.string(),
      what: z.string(),
      indicators: z.string(),
      where: z.string(),
      gaps: z.string().optional(),
      facts: z.string().optional(),
      unknowns: z.string().optional(),
      how: z.string().optional(),
      tags: z.string().optional(),
      parent: z.string().optional(),
      blockers: z.array(z.string()).optional(),
      status: z.enum(['Planning', 'Deferred']).optional(),
    }),
  },
  effort_select: {
    title: 'Select an Effort',
    description: 'Marks an Effort as in use by the calling thread.',
    inputSchema: z.object({ ref: z.string(), session }),
  },
  effort_release: {
    title: 'Release an Effort',
    description: 'Clears the calling thread as the Effort\'s holder.',
    inputSchema: z.object({ ref: z.string(), session }),
  },
  effort_update: {
    title: 'Update an Effort',
    description:
      'Changes an Effort: its status or assignee, or adds, resolves or cancels one gap, unknown, fact, indicator or task at a time.',
    inputSchema: z.object({
      ref: z.string(),
      session,
      status: z.enum(['Planning', 'Doing', 'Blocked', 'Review', 'Done', 'Paused', 'Deferred', 'Cancelled']).optional(),
      force: z.boolean().optional(),
      assigned: z.string().optional(),
      add_gap: z.string().optional(),
      resolve_gap: idNote.optional(),
      cancel_gap: idNote.optional(),
      add_unknown: z.string().optional(),
      resolve_unknown: idNote.optional(),
      cancel_unknown: idNote.optional(),
      add_fact: z.object({ text: z.string(), evidence: z.string() }).optional(),
      add_indicator: z.string().optional(),
      add_task: z.object({ text: z.string(), blockers: z.string().optional(), indicators: z.string().optional() }).optional(),
      check_task: z.string().optional(),
      cancel_task: idNote.optional(),
    }),
  },
  effort_depend: {
    title: 'Add or remove an Effort dependency',
    description: 'Adds or removes one Effort as a blocker of another.',
    inputSchema: z.object({ ref: z.string(), blocker: z.string(), action: z.enum(['add', 'remove']), session }),
  },
};

/** Names of the tools each role sees, for tests and docs. */
export const DOER_TOOLS = Object.keys(FIND_GET);
export const COORDINATOR_TOOLS = [...DOER_TOOLS, ...Object.keys(COORDINATOR_ONLY)];

/** Registers the role's Effort tools; each forwards its arguments unchanged to the same-named upstream tool. */
export function registerEffortTools(server: McpServer, env: Env, role: Role): void {
  const defs: Record<string, { title: string; description: string; inputSchema: z.ZodObject }> =
    role === 'coordinator' ? { ...FIND_GET, ...COORDINATOR_ONLY } : { ...FIND_GET };
  for (const [name, def] of Object.entries(defs)) {
    server.registerTool(name, def, (args: Record<string, unknown>) => respond(() => forward(env, role, name, args)));
  }
}
