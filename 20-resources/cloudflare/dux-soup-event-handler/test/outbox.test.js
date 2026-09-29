import { env, reset, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BASE, mockFetch } from "./helpers.js";

function outboxStub() {
  const id = env.OUTBOX.idFromName("outbox");
  return env.OUTBOX.get(id);
}

async function outboxRowCount(stub) {
  return runInDurableObject(stub, (instance) => [...instance.sql.exec("SELECT seq FROM outbox")].length);
}

async function deadLetterRowCount(stub) {
  return runInDurableObject(stub, (instance) => [...instance.sql.exec("SELECT seq FROM dead_letter")].length);
}

async function pump(stub, predicate, { timeout = 2000, interval = 15 } = {}) {
  const start = Date.now();
  for (;;) {
    await runDurableObjectAlarm(stub).catch(() => {});
    if (await predicate()) return true;
    if (Date.now() - start > timeout) return await predicate();
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

describe("event outbox", () => {
  let stub;

  beforeEach(() => {
    stub = outboxStub();
  });

  afterEach(async () => {
    await reset();
  });

  it("stores the raw body and delivers it once the receiver accepts", async () => {
    const mock = mockFetch([() => new Response(null, { status: 200 })]);
    try {
      const bodyText = JSON.stringify({ type: "visit", event: "profile", n: 1 });
      const res = await SELF.fetch(BASE, { method: "POST", body: bodyText });
      expect(res.status).toBe(200);

      await pump(stub, async () => (await outboxRowCount(stub)) === 0);

      expect(mock.calls.length).toBeGreaterThanOrEqual(1);
      const call = mock.calls[mock.calls.length - 1];
      expect(call.body).toBe(bodyText);
      expect(call.method).toBe("POST");
      expect(new URL(call.url).searchParams.get("key")).toBe("test-receiver-key");
    } finally {
      mock.restore();
    }
  });

  it("retries after a 503 and delivers exactly once, in order, once the receiver recovers", async () => {
    let attempt = 0;
    const mock = mockFetch([
      () => {
        attempt++;
        return attempt === 1 ? new Response(null, { status: 503 }) : new Response(null, { status: 200 });
      },
    ]);
    try {
      const bodyText = JSON.stringify({ type: "visit", event: "profile", n: 2 });
      await SELF.fetch(BASE, { method: "POST", body: bodyText });

      await pump(stub, async () => (await outboxRowCount(stub)) === 0);

      const bodies = mock.calls.map((c) => c.body);
      expect(bodies.every((b) => b === bodyText)).toBe(true);
      expect(attempt).toBeGreaterThanOrEqual(2);
      expect(await deadLetterRowCount(stub)).toBe(0);
    } finally {
      mock.restore();
    }
  });

  it("retries on a 401 without dead-lettering", async () => {
    let calls = 0;
    const mock = mockFetch([
      () => {
        calls++;
        return new Response(null, { status: 401 });
      },
    ]);
    try {
      const bodyText = JSON.stringify({ type: "visit", event: "profile", n: 3 });
      await SELF.fetch(BASE, { method: "POST", body: bodyText });

      await pump(stub, async () => calls >= 2, { timeout: 500 });

      expect(calls).toBeGreaterThanOrEqual(1);
      expect(await outboxRowCount(stub)).toBe(1);
      expect(await deadLetterRowCount(stub)).toBe(0);
    } finally {
      mock.restore();
    }
  });

  it("dead-letters a 400 and does not retry it", async () => {
    let calls = 0;
    const mock = mockFetch([
      () => {
        calls++;
        return new Response(null, { status: 400 });
      },
    ]);
    try {
      const bodyText = JSON.stringify({ type: "visit", event: "profile", n: 4 });
      await SELF.fetch(BASE, { method: "POST", body: bodyText });

      await pump(stub, async () => (await deadLetterRowCount(stub)) === 1);

      expect(calls).toBe(1);
      expect(await outboxRowCount(stub)).toBe(0);

      await pump(stub, async () => true, { timeout: 200 });
      expect(calls).toBe(1);
    } finally {
      mock.restore();
    }
  });

  it("keeps several events in order", async () => {
    const mock = mockFetch([() => new Response(null, { status: 200 })]);
    try {
      const bodies = [1, 2, 3, 4].map((n) => JSON.stringify({ type: "visit", event: "profile", n }));
      for (const bodyText of bodies) {
        const res = await SELF.fetch(BASE, { method: "POST", body: bodyText });
        expect(res.status).toBe(200);
      }

      await pump(stub, async () => (await outboxRowCount(stub)) === 0);

      const deliveredBodies = mock.calls.map((c) => c.body);
      expect(deliveredBodies).toEqual(bodies);
    } finally {
      mock.restore();
    }
  });
});
