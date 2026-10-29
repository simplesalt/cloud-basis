// node --test 20-resources/cloudflare/api-gateway/ApiGateway.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import gateway, { match } from "./ApiGateway.js";

test("matches a prefix exactly or at a path boundary only", () => {
  assert.ok(match("/45e6451afc312886/grammar"));
  assert.ok(match("/45e6451afc312886/grammar/x"));
  assert.equal(match("/45e6451afc312886/grammarx"), undefined);
  assert.equal(match("/45e6451afc312886"), undefined);
  assert.equal(match("/"), undefined);
});

test("unmapped paths answer 404 without forwarding", async () => {
  globalThis.fetch = () => assert.fail("must not forward");
  const res = await gateway.fetch(new Request("https://api.simplesalt.company/nope"));
  assert.equal(res.status, 404);
});

test("mapped paths forward the request unchanged to the entry's origin", async () => {
  let seen;
  globalThis.fetch = async (req, init) => {
    seen = { req, init };
    return new Response("ok");
  };
  const req = new Request("https://api.simplesalt.company/45e6451afc312886/grammar", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": "jwt", "Content-Type": "text/plain" },
    body: "hello",
  });
  const res = await gateway.fetch(req);
  assert.equal(await res.text(), "ok");
  assert.equal(seen.req, req);
  assert.deepEqual(seen.init, { cf: { resolveOverride: "ssint-main-origin.simplesalt.company" } });
});
