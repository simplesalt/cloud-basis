export const TOKEN = "test-route-token-abc123";
export const BASE = `https://example.com/${TOKEN}`;

export function validReceivedMessage(overrides = {}) {
  const { data: dataOverrides, ...rest } = overrides;
  return {
    userid: "user-1",
    time: "2024-01-01T00:00:00.000Z",
    type: "message",
    event: "received",
    data: {
      url: "https://www.linkedin.com/messaging/thread/abc/",
      timestamp: "2024-01-01T00:00:00.000Z",
      from: "Jane Doe",
      fromId: "abc123",
      fromFirstName: "Jane",
      fromLastName: "Doe",
      type: "INMAIL",
      tags: [],
      text: "Hello there",
      ...dataOverrides,
    },
    ...rest,
  };
}

export function mockQueueSend(env) {
  const sent = [];
  const original = env.main_InMessage_LI.send;
  env.main_InMessage_LI.send = async (message) => {
    sent.push(message);
  };
  return {
    sent,
    restore: () => {
      env.main_InMessage_LI.send = original;
    },
  };
}

export function mockFetch(handlers) {
  const calls = [];
  const original = globalThis.fetch;
  let idx = 0;
  globalThis.fetch = async (url, init) => {
    const record = {
      url: String(url),
      method: init?.method,
      body: init?.body,
      headers: init?.headers,
    };
    calls.push(record);
    const handler = handlers[Math.min(idx, handlers.length - 1)];
    idx++;
    return handler(record);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
