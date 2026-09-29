import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE, TOKEN, mockQueueSend, validReceivedMessage } from "./helpers.js";

describe("method and path checks", () => {
  it("rejects non-POST with 405", async () => {
    const res = await SELF.fetch(BASE);
    expect(res.status).toBe(405);
    expect(await res.text()).toBe("Method Not Allowed");
  });

  it("rejects an unrecognised token with 404", async () => {
    const res = await SELF.fetch("https://example.com/not-the-token", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });

  it("rejects a token used as a bare prefix without a slash boundary", async () => {
    const res = await SELF.fetch(`https://example.com/${TOKEN}extra`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });

  it("rejects a workers.dev-style root path", async () => {
    const res = await SELF.fetch("https://example.com/", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });

  it("accepts the exact token path", async () => {
    const res = await SELF.fetch(BASE, { method: "POST", body: JSON.stringify({ type: "visit", event: "profile" }) });
    expect(res.status).toBe(200);
  });

  it("accepts the token with a trailing subpath", async () => {
    const res = await SELF.fetch(`${BASE}/anything`, { method: "POST", body: JSON.stringify({ type: "visit" }) });
    expect(res.status).toBe(200);
  });
});

describe("body parsing", () => {
  it("returns 400 invalid_json for unparseable bodies", async () => {
    const res = await SELF.fetch(BASE, { method: "POST", body: "{not json" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_json");
    expect(typeof body.detail).toBe("string");
  });

  it("returns 400 validation_failed for a JSON array body", async () => {
    const res = await SELF.fetch(BASE, { method: "POST", body: "[1,2,3]" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "validation_failed", detail: "payload must be a JSON object" });
  });

  it("returns 400 validation_failed for a JSON string body", async () => {
    const res = await SELF.fetch(BASE, { method: "POST", body: '"just a string"' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "validation_failed", detail: "payload must be a JSON object" });
  });

  it("returns 400 validation_failed for a null body", async () => {
    const res = await SELF.fetch(BASE, { method: "POST", body: "null" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "validation_failed", detail: "payload must be a JSON object" });
  });
});

describe("received messages", () => {
  it("accepts a valid received message and queues it", async () => {
    const mock = mockQueueSend(env);
    try {
      const payload = validReceivedMessage();
      const res = await SELF.fetch(BASE, { method: "POST", body: JSON.stringify(payload) });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body).toEqual({ status: "accepted", topic: "main.InMessage.LI" });

      expect(mock.sent).toHaveLength(1);
      const message = JSON.parse(mock.sent[0]);
      expect(message).toEqual({ topic: "main.InMessage.LI", payload });
    } finally {
      mock.restore();
    }
  });

  it.each(["MEMBER_TO_MEMBER", "INVITATION_ACCEPT", "INMAIL"])(
    "accepts data.type %s",
    async (dataType) => {
      const mock = mockQueueSend(env);
      try {
        const payload = validReceivedMessage({ data: { type: dataType } });
        const res = await SELF.fetch(BASE, { method: "POST", body: JSON.stringify(payload) });
        expect(res.status).toBe(202);
        expect(mock.sent).toHaveLength(1);
      } finally {
        mock.restore();
      }
    }
  );

  it("rejects a message missing userid", async () => {
    const payload = validReceivedMessage();
    delete payload.userid;
    const res = await SELF.fetch(BASE, { method: "POST", body: JSON.stringify(payload) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed", detail: "userid must be a string" });
  });

  it("rejects a message missing time", async () => {
    const payload = validReceivedMessage();
    delete payload.time;
    const res = await SELF.fetch(BASE, { method: "POST", body: JSON.stringify(payload) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed", detail: "time must be a string (ISO date-time)" });
  });

  it("rejects a message missing data", async () => {
    const payload = validReceivedMessage();
    delete payload.data;
    const res = await SELF.fetch(BASE, { method: "POST", body: JSON.stringify(payload) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed", detail: "data must be an object" });
  });

  it("rejects a message missing a required data field", async () => {
    const payload = validReceivedMessage();
    delete payload.data.fromId;
    const res = await SELF.fetch(BASE, { method: "POST", body: JSON.stringify(payload) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed", detail: "data.fromId is required" });
  });

  it("rejects a message with an invalid data.type", async () => {
    const payload = validReceivedMessage({ data: { type: "SOMETHING_ELSE" } });
    const res = await SELF.fetch(BASE, { method: "POST", body: JSON.stringify(payload) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "validation_failed",
      detail: "data.type must be one of MEMBER_TO_MEMBER, INVITATION_ACCEPT, INMAIL",
    });
  });

  it("rejects a message where data.tags is not an array", async () => {
    const payload = validReceivedMessage({ data: { tags: "not-an-array" } });
    const res = await SELF.fetch(BASE, { method: "POST", body: JSON.stringify(payload) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed", detail: "data.tags must be an array" });
  });
});

describe("non-message events", () => {
  it.each([
    { type: "visit", event: "profile" },
    { type: "action", event: "connect" },
    { type: "session", event: "start" },
    { type: "message", event: "sent" },
  ])("forwards %o unchanged with a 200", async (payload) => {
    const res = await SELF.fetch(BASE, { method: "POST", body: JSON.stringify(payload) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "forwarded" });
  });
});
