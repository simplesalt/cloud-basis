// Public OIDC discovery for the ssint-main cluster's service-account issuer,
// served on oidc.simplesalt.company with no route into the cluster. Relying
// parties (e.g. OpenRouter) fetch the discovery document and the key set from
// here to verify projected service-account tokens.
//
// The key set lives in KV key "jwks", written every ten minutes by the
// oidc-keys-sync CronJob in simplesalt/basis (cluster-main-identity). This
// Worker only reads it. Only GET and HEAD on the two paths below answer;
// everything else is 404.
export const ISSUER = "https://kubernetes.default.svc.k.famevans.win";
export const JWKS_URI = "https://oidc.simplesalt.company/openid/v1/jwks";

export const DISCOVERY = JSON.stringify({
  issuer: ISSUER,
  jwks_uri: JWKS_URI,
  response_types_supported: ["id_token"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["RS256"],
});

const HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=300",
};

function respond(request, body, status = 200, headers = HEADERS) {
  return new Response(request.method === "HEAD" ? null : body, { status, headers });
}

const notFound = (request) =>
  respond(request, JSON.stringify({ error: "not_found" }), 404, {
    "Content-Type": "application/json",
  });

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") return notFound(request);
    const { pathname } = new URL(request.url);
    if (pathname === "/.well-known/openid-configuration") {
      return respond(request, DISCOVERY);
    }
    if (pathname === "/openid/v1/jwks") {
      const jwks = await env.KEYS.get("jwks");
      if (jwks === null) {
        return respond(request, JSON.stringify({ error: "keys_unavailable" }), 503, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
      }
      return respond(request, jwks);
    }
    return notFound(request);
  },
};
