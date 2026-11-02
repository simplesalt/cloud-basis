import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

/**
 * Runtime bindings the Worker expects. All are wired up by the Crossplane
 * Script manifest (30-mcp/worker-script.yaml) generated from this package.
 */
export interface Env {
  /** OAuth authorization-server state (grants, tokens, codes, client registrations). */
  OAUTH_KV: KVNamespace;
  /** Client secret of the Access for SaaS OIDC application, never logged. */
  ACCESS_CLIENT_SECRET: string;
  /** Signing key for the "remember this browser's consent" cookie. */
  COOKIE_ENCRYPTION_KEY: string;
  /** The 32-hex path secret. Never committed to git; supplied at deploy time. */
  MCP_SLUG: string;
  /** Workers VPC service binding to Hindsight (in-cluster REST, no auth). */
  HINDSIGHT: Fetcher;
  /** Workers VPC service binding to gbrain (in-cluster /mcp endpoint). */
  GBRAIN: Fetcher;
  /** Workers VPC service binding to the hermes-chats read API (in-cluster REST, no auth; GET only). */
  HERMES_CHATS: Fetcher;
  /**
   * Injected by @cloudflare/workers-oauth-provider on every request it
   * routes to defaultHandler; not a real deploy-time binding.
   */
  OAUTH_PROVIDER: OAuthHelpers;
}
