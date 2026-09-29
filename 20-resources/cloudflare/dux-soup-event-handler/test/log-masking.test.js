import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE, TOKEN, captureConsole } from "./helpers.js";

function assertTokenAbsent(lines) {
  for (const line of lines) {
    expect(line).not.toContain(TOKEN);
  }
}

describe("route token masking in logs", () => {
  it("masks the path on handler_invoked for a valid request", async () => {
    const capture = captureConsole();
    try {
      const res = await SELF.fetch(BASE, { method: "POST", body: JSON.stringify({ type: "visit", event: "profile" }) });
      expect(res.status).toBe(200);
    } finally {
      capture.restore();
    }

    expect(capture.lines.length).toBeGreaterThan(0);
    assertTokenAbsent(capture.lines);

    const invoked = capture.lines.find((l) => l.includes("handler_invoked"));
    expect(invoked).toBeDefined();
    expect(invoked).toContain("/<redacted>");
  });

  it("masks the path on invalid_path for a request under the wrong token", async () => {
    const capture = captureConsole();
    try {
      const res = await SELF.fetch("https://example.com/not-the-token", { method: "POST", body: "{}" });
      expect(res.status).toBe(404);
    } finally {
      capture.restore();
    }

    assertTokenAbsent(capture.lines);

    const invalidPath = capture.lines.find((l) => l.includes("invalid_path"));
    expect(invalidPath).toBeDefined();
    expect(invalidPath).toContain("/<redacted>");
  });

  it("masks the path and does not log the raw query string on a non-2xx response", async () => {
    const capture = captureConsole();
    let res;
    try {
      res = await SELF.fetch(`${BASE}?foo=bar`, { method: "POST", body: "{not json" });
    } finally {
      capture.restore();
    }
    expect(res.status).toBe(400);

    assertTokenAbsent(capture.lines);
    for (const line of capture.lines) {
      expect(line).not.toContain("foo=bar");
    }

    const non2xx = capture.lines.find((l) => l.includes("non_2xx_response"));
    expect(non2xx).toBeDefined();
    expect(non2xx).toContain("/<redacted>");
    expect(non2xx).toContain("hasQuery");
  });
});
