// The MCP surface itself: one placeholder tool, `whoami`. Real tools come
// later (this Effort is scoped to auth only).
//
// Library choice: @modelcontextprotocol/server's createMcpHandler() serves
// Streamable HTTP statelessly, one fresh server instance per HTTP request,
// over a plain Fetch Request/Response — no Durable Object, no session
// storage. Its only runtime dependency is zod. The alternative offered by
// the task, the `agents` SDK, models an MCP server as a stateful Agent
// class backed by a Durable Object even in its "stateless" examples; that
// is unnecessary machinery (and a pricier binding) for a handler that holds
// no state between calls, so it was not used. See build.sh / package.json
// for exactly which package versions this depends on.
import { createMcpHandler, McpServer, type McpHttpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';

/**
 * The subset of @modelcontextprotocol/core-internal's AuthInfo this Worker
 * populates. Not imported from the package (it lives in an "-internal"
 * package not meant to be depended on directly) — TypeScript's structural
 * typing accepts this object wherever the SDK's own AuthInfo is expected.
 */
export interface WorkerAuthInfo {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt?: number;
  extra?: Record<string, unknown>;
}

let handler: McpHttpHandler | undefined;

/** The stateless MCP HTTP handler, built once per isolate (it holds no per-request state). */
export function getMcpHandler(): McpHttpHandler {
  if (handler === undefined) {
    handler = createMcpHandler(() => {
      const server = new McpServer({ name: 'ssint-main-mcp-server', version: '0.1.0' });
      server.registerTool(
        'whoami',
        {
          title: 'Who am I',
          description: "Returns the signed-in caller's verified email address.",
          inputSchema: z.object({}),
          outputSchema: z.object({ email: z.string() }),
        },
        (_args, ctx) => {
          const email = ctx.http?.authInfo?.extra?.email;
          if (typeof email !== 'string' || email === '') {
            throw new Error('No verified email on this session.');
          }
          return {
            content: [{ type: 'text', text: `Signed in as ${email}` }],
            structuredContent: { email },
          };
        }
      );
      return server;
    });
  }
  return handler;
}
