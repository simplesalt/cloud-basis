import { DurableObject } from "cloudflare:workers";

const DEFAULTS = {
  BRANCH: "main",
  OUTBOX_RETRY_BASE_MS: 10000,
};

const DEAD_LETTER_STATUSES = [400, 413, 415, 422];
const OUTBOX_BATCH_SIZE = 20;
const OUTBOX_MAX_BACKOFF_MS = 10 * 60 * 1000;

function cfLog(level, fn, msg, meta) {
  try {
    const ts = new Date().toISOString();
    const redacted = redact(meta);
    const entry = { ts, level, fn, msg, meta: redacted };
    if (level === "debug") console.debug(JSON.stringify(entry));
    else if (level === "info") console.log(JSON.stringify(entry));
    else if (level === "warn") console.warn(JSON.stringify(entry));
    else console.error(JSON.stringify(entry));
  } catch (e) {
    console.error("cfLog error", e);
  }
}

function redact(obj) {
  if (obj === void 0) return void 0;
  if (obj === null) return null;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const sensitiveKeyPattern = /token|secret|password|pass|apikey|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|bearer|supabase/i;
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (sensitiveKeyPattern.test(k)) {
      result[k] = "[REDACTED]";
      continue;
    }
    if (typeof v === "string" && v.length > 100 && /[A-Za-z0-9\-_]{20,}/.test(v)) {
      result[k] = "[REDACTED_LONG]";
      continue;
    }
    if (typeof v === "string" && /Bearer\s+[A-Za-z0-9\-_.]+/i.test(v)) {
      result[k] = "[REDACTED_BEARER]";
      continue;
    }
    result[k] = redact(v);
  }
  return result;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function firstPathSegment(pathname) {
  const idx = pathname.indexOf("/", 1);
  return idx === -1 ? pathname.slice(1) : pathname.slice(1, idx);
}

const REDACTED_ROUTE_SEGMENT = "<redacted>";

function maskRoutePath(pathname) {
  if (typeof pathname !== "string") return pathname;
  const idx = pathname.indexOf("/", 1);
  const rest = idx === -1 ? "" : pathname.slice(idx);
  return "/" + REDACTED_ROUTE_SEGMENT + rest;
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function sanitizeBindingName(name) {
  try {
    let s = String(name || "");
    s = s.replace(/[^A-Za-z0-9_]/g, "_");
    if (!/^[A-Za-z_]/.test(s)) s = "_" + s;
    s = s.replace(/_+/g, "_");
    return s;
  } catch {
    return "QUEUE";
  }
}

function getQueueFromEnv(env, bindingKey) {
  if (!env) return void 0;
  const sanitized = sanitizeBindingName(bindingKey);
  return env[sanitized] || env[bindingKey];
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object") return "payload must be a JSON object";
  if (typeof payload.userid !== "string") return "userid must be a string";
  if (typeof payload.time !== "string") return "time must be a string (ISO date-time)";
  if (payload.type !== "message") return "type must be 'message'";
  if (payload.event !== "received") return "event must be 'received'";
  const data = payload.data;
  if (!data || typeof data !== "object") return "data must be an object";
  const required = [
    "url",
    "timestamp",
    "from",
    "fromId",
    "fromFirstName",
    "fromLastName",
    "type",
    "tags",
    "text",
  ];
  for (const k of required) {
    if (!(k in data)) return "data." + k + " is required";
  }
  if (typeof data.url !== "string") return "data.url must be a string";
  if (typeof data.timestamp !== "string") return "data.timestamp must be a string (ISO date-time)";
  if (typeof data.from !== "string") return "data.from must be a string";
  if (typeof data.fromId !== "string") return "data.fromId must be a string";
  if (typeof data.fromFirstName !== "string") return "data.fromFirstName must be a string";
  if (typeof data.fromLastName !== "string") return "data.fromLastName must be a string";
  if (!["MEMBER_TO_MEMBER", "INVITATION_ACCEPT", "INMAIL"].includes(data.type)) return "data.type must be one of MEMBER_TO_MEMBER, INVITATION_ACCEPT, INMAIL";
  if (!Array.isArray(data.tags)) return "data.tags must be an array";
  if (typeof data.text !== "string") return "data.text must be a string";
  return null;
}

async function recordToOutbox(env, bodyText) {
  const id = env.OUTBOX.idFromName("outbox");
  const stub = env.OUTBOX.get(id);
  await stub.record(bodyText);
}

async function handler(request, env) {
  const pathname = new URL(request.url).pathname;
  cfLog("debug", "duxsoup_handler", "handler_invoked", { method: request.method, path: maskRoutePath(pathname) });

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const routeHash = env.ROUTE_PATH_SHA256;
  if (!routeHash) throw new Error("ROUTE_PATH_SHA256 not configured");

  const segment = firstPathSegment(pathname);
  const structureOk = pathname === "/" + segment || pathname.startsWith("/" + segment + "/");
  const segmentHash = await sha256Hex(segment);
  if (!structureOk || !timingSafeEqualHex(segmentHash, routeHash.toLowerCase())) {
    cfLog("warn", "duxsoup_handler", "invalid_path", { path: maskRoutePath(pathname) });
    return new Response("Not Found", { status: 404 });
  }

  const bodyText = await request.text();
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch (err) {
    return jsonResponse({ error: "invalid_json", detail: String(err) }, 400);
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return jsonResponse({ error: "validation_failed", detail: "payload must be a JSON object" }, 400);
  }

  cfLog("debug", "duxsoup_handler", "payload_parsed", { userid: payload?.userid, type: payload?.type, event: payload?.event, dataType: payload?.data?.type });

  let outboxError;
  try {
    await recordToOutbox(env, bodyText);
  } catch (err) {
    outboxError = err;
    cfLog("error", "duxsoup_handler", "outbox_record_failed", { error: String(err?.message || err) });
  }

  if (payload.type === "message" && payload.event === "received") {
    const validationError = validatePayload(payload);
    if (validationError) return jsonResponse({ error: "validation_failed", detail: validationError }, 400);

    const branch = (env.BRANCH || DEFAULTS.BRANCH).toString();
    const objectType = "InMessage";
    const source = "LI";
    const topic = [branch, objectType, source].join(".");
    const bindingKey = [branch, objectType, source].join(".");
    const queue = getQueueFromEnv(env, bindingKey);
    if (!queue || typeof queue.send !== "function") throw new Error("Queue binding '" + bindingKey + "' not found");
    const message = { topic, payload };
    try {
      await queue.send(JSON.stringify(message));
      cfLog("info", "duxsoup_handler", "message_queued", { topic, binding: bindingKey });
    } catch (err) {
      cfLog("error", "duxsoup_handler", "queue_send_failed", { topic, error: String(err), binding: bindingKey });
      throw err;
    }
    return jsonResponse({ status: "accepted", topic }, 202);
  }

  if (outboxError) {
    throw outboxError;
  }

  return jsonResponse({ status: "forwarded" }, 200);
}

function withResponseLogging(fn, workerName) {
  return async (request, env, ctx) => {
    const url = new URL(request.url);
    try {
      const res = await fn(request, env, ctx);
      if (!res || !res.ok) {
        const level = res && res.status >= 500 ? "error" : "warn";
        cfLog(level, workerName, "non_2xx_response", {
          method: request.method,
          path: maskRoutePath(url.pathname),
          status: res ? res.status : "no_response",
          hasQuery: url.search.length > 0,
          ray: request.headers.get("cf-ray") || void 0,
        });
      }
      return res;
    } catch (err) {
      cfLog("error", workerName, "unhandled_exception", {
        method: request.method,
        path: maskRoutePath(url.pathname),
        error: String(err?.message || err),
      });
      throw err;
    }
  };
}

export class EventOutbox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL,
      received_at TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS dead_letter (
      seq INTEGER PRIMARY KEY,
      body TEXT NOT NULL,
      received_at TEXT NOT NULL,
      dead_at TEXT NOT NULL,
      status INTEGER NOT NULL
    )`);
  }

  async record(body) {
    const receivedAt = new Date().toISOString();
    this.sql.exec("INSERT INTO outbox (body, received_at) VALUES (?, ?)", body, receivedAt);
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (existingAlarm === null) {
      await this.ctx.storage.setAlarm(Date.now());
    }
    cfLog("debug", "event_outbox", "recorded", { receivedAt });
  }

  async deliverRow(row) {
    const url = this.env.RECEIVER_URL + "?key=" + encodeURIComponent(this.env.RECEIVER_KEY);
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: row.body,
      });
    } catch (err) {
      cfLog("warn", "event_outbox", "delivery_network_error", { seq: row.seq, error: String(err?.message || err) });
      return { delivered: false };
    }
    if (response.ok) {
      return { delivered: true };
    }
    if (DEAD_LETTER_STATUSES.includes(response.status)) {
      return { delivered: false, deadLetter: true, status: response.status };
    }
    cfLog("warn", "event_outbox", "delivery_failed", { seq: row.seq, status: response.status });
    return { delivered: false, status: response.status };
  }

  async alarm() {
    const baseMs = Number(this.env.OUTBOX_RETRY_BASE_MS) || DEFAULTS.OUTBOX_RETRY_BASE_MS;
    const rows = [...this.sql.exec("SELECT seq, body, received_at FROM outbox ORDER BY seq ASC LIMIT ?", OUTBOX_BATCH_SIZE)];
    if (rows.length === 0) return;

    for (const row of rows) {
      const outcome = await this.deliverRow(row);

      if (outcome.delivered) {
        this.sql.exec("DELETE FROM outbox WHERE seq = ?", row.seq);
        await this.ctx.storage.put("consecutiveFailures", 0);
        cfLog("info", "event_outbox", "delivered", { seq: row.seq });
        continue;
      }

      if (outcome.deadLetter) {
        this.sql.exec(
          "INSERT INTO dead_letter (seq, body, received_at, dead_at, status) VALUES (?, ?, ?, ?, ?)",
          row.seq,
          row.body,
          row.received_at,
          new Date().toISOString(),
          outcome.status
        );
        this.sql.exec("DELETE FROM outbox WHERE seq = ?", row.seq);
        cfLog("warn", "event_outbox", "dead_lettered", { seq: row.seq, status: outcome.status });
        continue;
      }

      const failures = ((await this.ctx.storage.get("consecutiveFailures")) || 0) + 1;
      await this.ctx.storage.put("consecutiveFailures", failures);
      const delayMs = Math.min(baseMs * 2 ** (failures - 1), OUTBOX_MAX_BACKOFF_MS);
      await this.ctx.storage.setAlarm(Date.now() + delayMs);
      cfLog("warn", "event_outbox", "retry_scheduled", { seq: row.seq, status: outcome.status, attempt: failures, delayMs });
      return;
    }

    const more = [...this.sql.exec("SELECT seq FROM outbox LIMIT 1")];
    if (more.length > 0) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }
}

export default {
  fetch: withResponseLogging(async (request, env, ctx) => handler(request, env), "duxsoup_event_handler"),
};
