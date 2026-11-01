// node --test 20-resources/cloudflare/oidc-keys/OidcKeys.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "./OidcKeys.js";

const JWKS = '{"keys":[{"kty":"RSA","kid":"k1","n":"abc","e":"AQAB"}]}';
const env = (value = JWKS) => ({ KEYS: { get: async (k) => (k === "jwks" ? value : null) } });
const req = (path, method = "GET") => new Request("https://oidc.simplesalt.company" + path, { method });

test("discovery document is fixed and cacheable", async () => {
  const res = await worker.fetch(req("/.well-known/openid-configuration"), env());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/json");
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=300");
  assert.deepEqual(await res.json(), {
    issuer: "https://kubernetes.default.svc.k.famevans.win",
    jwks_uri: "https://oidc.simplesalt.company/openid/v1/jwks",
    response_types_supported: ["id_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
  });
});

test("jwks is returned verbatim from KV", async () => {
  const res = await worker.fetch(req("/openid/v1/jwks"), env());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/json");
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=300");
  assert.equal(await res.text(), JWKS);
});

test("jwks answers 503 when the key is missing", async () => {
  const res = await worker.fetch(req("/openid/v1/jwks"), env(null));
  assert.equal(res.status, 503);
});

test("HEAD answers without a body", async () => {
  const res = await worker.fetch(req("/openid/v1/jwks", "HEAD"), env());
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "");
});

test("other paths and methods are 404", async () => {
  for (const p of ["/", "/api", "/version", "/openid/v1/jwks/", "/.well-known/openid-configurationx"]) {
    assert.equal((await worker.fetch(req(p), env())).status, 404, p);
  }
  assert.equal((await worker.fetch(req("/openid/v1/jwks", "POST"), env())).status, 404);
});
