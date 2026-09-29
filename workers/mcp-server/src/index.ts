// Remote MCP server: a single Cloudflare Worker that is both the OAuth
// authorization server MCP clients talk to and the resource server serving
// /<slug>/mcp. Cloudflare Access (a SaaS OIDC application, created outside
// this repo) is the identity check: this Worker never accepts an email from
// the browser, only the verified id_token Access returns on the token
// back-channel (see src/access.ts).
//
// Scope is auth only (simplesalt/projects#594 T2): one placeholder tool
// (src/mcp.ts's `whoami`); real tools come later.
//
// Routing:
//   HOST (from config.json, PENDING until filled in)
//     /.well-known/oauth-protected-resource/<slug>/mcp   \ served by
//     /.well-known/oauth-authorization-server            / OAuthProvider
//                                  (minus protected_resources, which names the slug)
//     /authorize            (GET shows consent, POST decides)  -- ours
//     /oauth/token          \ served by OAuthProvider
//     /oauth/register       /
//     /oauth/callback        -- ours: Access redirects here
//     /<slug>/mcp             -- ours, behind OAuthProvider's apiHandler
//     anything else           -- 404, no slug ever echoed back
//   api.simplesalt.company (fixed, not from config.json)
//     /<slug>*  -- 308 to https://HOST/<slug>... (documentation signpost)
//     anything else -- 404
import {
  authorizationErrorRedirect,
  OAuthProvider,
  type AuthRequest,
  type OAuthResourceAuth,
} from '@cloudflare/workers-oauth-provider';

import { accessAuthorizationEndpoint, exchangeCodeForEmail } from './access';
import { API_SIGNPOST_HOST, BUILD_CONFIG } from './config';
import { renderConsentPage } from './consent';
import type { Env } from './env';
import { getMcpHandler, type WorkerAuthInfo } from './mcp';
import { generateVerifier, s256Challenge } from './pkce';

function notFound(): Response {
  return new Response('Not Found', { status: 404 });
}

function callbackUrl(): string {
  return `https://${BUILD_CONFIG.host}/oauth/callback`;
}

/** The signed cookie that lets a returning browser skip the consent page. */
function rememberOptions(env: Env): { secret: string } {
  return { secret: env.COOKIE_ENCRYPTION_KEY };
}

/**
 * Redirects to Access's authorize endpoint with a fresh PKCE pair, after
 * consent (or a remembered approval) has already been established for this
 * client. `extraHeaders` carries cookies from the caller (the consent-cookie
 * clear, for instance) that must ride along on this same redirect.
 */
async function redirectToAccess(env: Env, authRequest: AuthRequest, extraHeaders: Headers): Promise<Response> {
  const verifier = generateVerifier();
  const { state, headers } = await env.OAUTH_PROVIDER.beginUpstream(authRequest, {
    data: { verifier },
    headers: extraHeaders,
  });

  const authorizeUrl = new URL(accessAuthorizationEndpoint());
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', BUILD_CONFIG.accessClientId);
  authorizeUrl.searchParams.set('redirect_uri', callbackUrl());
  authorizeUrl.searchParams.set('scope', 'openid email profile');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', await s256Challenge(verifier));
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  headers.set('Location', authorizeUrl.toString());
  return new Response(null, { status: 302, headers });
}

function renderAuthorizationError(error: unknown): Response {
  if (error instanceof Error && error.name === 'AuthorizationError') {
    const authError = error as Error & { redirectTo?: string; description?: string };
    if (authError.redirectTo) {
      return Response.redirect(authError.redirectTo, 302);
    }
    const message = authError.description ?? authError.message;
    return new Response(message, { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (error instanceof Error && error.name === 'CimdFetchError') {
    return new Response('This app could not be verified.', {
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  throw error;
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;

  try {
    if (request.method === 'POST') {
      const form = await request.formData();
      const handle = String(form.get('handle') ?? '');

      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }

      const approved = await oauth.approveConsent(request, handle, {
        scope: [],
        remember: rememberOptions(env),
      });
      return await redirectToAccess(env, approved.request, approved.headers);
    }

    // GET: parse first so a malformed request never reaches beginConsent/KV.
    const authRequest = await oauth.parseAuthRequest(request);

    if (await oauth.isConsentRemembered(request, authRequest, rememberOptions(env))) {
      return await redirectToAccess(env, authRequest, new Headers());
    }

    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    consent.headers.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(renderConsentPage(details, consent.handle), { headers: consent.headers });
  } catch (error) {
    return renderAuthorizationError(error);
  }
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;

  try {
    const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);

    const url = new URL(request.url);
    if (url.searchParams.has('error')) {
      headers.set('Location', authorizationErrorRedirect(original, 'access_denied'));
      return new Response(null, { status: 302, headers });
    }

    const code = url.searchParams.get('code');
    if (!code) {
      return new Response('Missing authorization code from the identity provider.', { status: 400 });
    }

    const { email } = await exchangeCodeForEmail({
      code,
      codeVerifier: data.verifier,
      redirectUri: callbackUrl(),
      clientSecret: env.ACCESS_CLIENT_SECRET,
    });

    const { redirectTo } = await oauth.completeAuthorization({
      request: original,
      userId: email,
      metadata: {},
      scope: [],
      props: { email },
    });
    headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    if (error instanceof Error && error.name === 'AuthorizationError') {
      return renderAuthorizationError(error);
    }
    // Never the code, verifier or secret: only what went wrong, for Workers Logs.
    console.error('oauth callback failed:', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    return new Response('Sign-in with the identity provider failed.', { status: 502 });
  }
}

function handleSignpost(url: URL, env: Env): Response {
  const slug = env.MCP_SLUG;
  if (slug && url.pathname.startsWith(`/${slug}`)) {
    const target = new URL(`${url.pathname}${url.search}`, `https://${BUILD_CONFIG.host}`);
    return Response.redirect(target.toString(), 308);
  }
  return notFound();
}

/**
 * Drops protected_resources from the authorization-server metadata. That
 * document is public at the host root and the only resource it would list
 * is the /<slug>/mcp URL; clients reach the resource through the 401's
 * resource_metadata pointer instead, so the list only ever leaked the slug.
 */
async function withoutProtectedResources(response: Response): Promise<Response> {
  const metadata = (await response.json()) as Record<string, unknown>;
  delete metadata.protected_resources;
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  return new Response(JSON.stringify(metadata), { status: response.status, headers });
}

/** The execution context OAuthProvider hands apiHandler: ctx.props from completeAuthorization(), ctx.auth from its own token record. */
interface ApiExecutionContext extends ExecutionContext {
  readonly props: { email?: string };
  readonly auth: OAuthResourceAuth;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.hostname === API_SIGNPOST_HOST) {
      return handleSignpost(url, env);
    }

    const provider = new OAuthProvider<Env>({
      apiRoute: `/${env.MCP_SLUG}/mcp`,
      apiHandler: {
        // Method shorthand (not an arrow assigned to a property) so this
        // object structurally satisfies ExportedHandlerWithFetch<Env>,
        // whose declared ctx is a plain ExecutionContext, while still
        // getting the auth/props fields OAuthProvider actually attaches.
        async fetch(mcpRequest: Request, mcpEnv: Env, mcpCtx: ExecutionContext): Promise<Response> {
          const apiCtx = mcpCtx as ApiExecutionContext;
          const authInfo: WorkerAuthInfo = {
            token: apiCtx.auth.token,
            clientId: apiCtx.auth.clientId ?? '',
            scopes: apiCtx.auth.scope,
            expiresAt: apiCtx.auth.expiresAt,
            extra: { email: apiCtx.props.email },
          };
          return getMcpHandler().fetch(mcpRequest, { authInfo });
        },
      },
      defaultHandler: {
        async fetch(defaultRequest: Request, defaultEnv: Env): Promise<Response> {
          const { pathname } = new URL(defaultRequest.url);
          if (pathname === '/authorize') return handleAuthorize(defaultRequest, defaultEnv);
          if (pathname === '/oauth/callback') return handleCallback(defaultRequest, defaultEnv);
          return notFound();
        },
      },
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      resourceMetadata: {
        resource: `https://${BUILD_CONFIG.host}/${env.MCP_SLUG}/mcp`,
        authorization_servers: [`https://${BUILD_CONFIG.host}`],
        resource_name: 'SimpleSalt MCP server',
      },
      clientIdMetadataDocumentEnabled: true,
    });

    const response = await provider.fetch(request, env, ctx);
    if (url.pathname === '/.well-known/oauth-authorization-server' && request.method === 'GET' && response.ok) {
      return withoutProtectedResources(response);
    }
    return response;
  },
};
