// Cloudflare Access for SaaS (OIDC) client: this Worker is the confidential
// client, Access is the identity check. Endpoint shapes are fixed by
// Cloudflare (see https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/):
//   https://<team-auth-domain>/cdn-cgi/access/sso/oidc/<client_id>/{authorization,token,jwks,userinfo}
// The verified email is read from the id_token returned on the back-channel
// token exchange, never from anything the browser/client supplies.
import { createRemoteJWKSet, jwtVerify } from 'jose';

import { BUILD_CONFIG } from './config';

function accessBase(): string {
  return `https://${BUILD_CONFIG.accessAuthDomain}/cdn-cgi/access/sso/oidc/${BUILD_CONFIG.accessClientId}`;
}

export function accessAuthorizationEndpoint(): string {
  return `${accessBase()}/authorization`;
}

function accessTokenEndpoint(): string {
  return `${accessBase()}/token`;
}

function accessJwksUri(): string {
  return `${accessBase()}/jwks`;
}

function accessIssuer(): string {
  return accessBase();
}

// Memoized per-isolate: createRemoteJWKSet caches key material across calls
// and there is exactly one Access application, so one JWKS fetcher for the
// isolate's lifetime is correct and avoids re-fetching keys per request.
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (jwks === undefined) {
    jwks = createRemoteJWKSet(new URL(accessJwksUri()));
  }
  return jwks;
}

export interface ExchangeParams {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientSecret: string;
}

export interface ExchangeResult {
  /** The verified email claim from Access's id_token. */
  email: string;
}

/**
 * Exchanges an authorization code at Access's token endpoint and returns the
 * caller's verified email, read from the signature-checked id_token.
 */
export async function exchangeCodeForEmail(params: ExchangeParams): Promise<ExchangeResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: BUILD_CONFIG.accessClientId,
    client_secret: params.clientSecret,
    code_verifier: params.codeVerifier,
  });

  const response = await fetch(accessTokenEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Access token exchange failed with status ${response.status}: ${detail.slice(0, 200)}`);
  }

  const tokens = (await response.json()) as { id_token?: unknown };
  if (typeof tokens.id_token !== 'string' || tokens.id_token === '') {
    throw new Error('Access token response did not include an id_token');
  }

  const { payload } = await jwtVerify(tokens.id_token, getJwks(), {
    issuer: accessIssuer(),
    audience: BUILD_CONFIG.accessClientId,
  });

  const email = payload.email;
  if (typeof email !== 'string' || email === '') {
    throw new Error('Access id_token did not carry a verified email claim');
  }

  return { email };
}
