import { afterEach, beforeEach } from "vitest";

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = async () => new Response(null, { status: 200 });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});
