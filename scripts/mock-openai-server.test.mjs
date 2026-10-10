// The mock's contract, pinned before the server existed (RED first).
//
// The server is the executable witness of the compat wire (D119): it refuses
// anything the translator must never send and streams the scenarios the e2e
// drives (text, artifact tool call, question tool call). If the mock lies,
// the e2e lies — so its validation and its stream shape are both under test.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startMockServer } from "./mock-openai-server.mjs";

/** The body `translate_request` + `send_once` produce for a plain turn. */
const VALID_BODY = {
  model: "mock-text",
  max_tokens: 1024,
  stream: true,
  messages: [
    { role: "system", content: "You are Clauro." },
    { role: "user", content: "hello" },
  ],
};

let server;
let base;

beforeEach(async () => {
  server = await startMockServer({ port: 0 });
  base = server.url;
});

afterEach(async () => {
  await server.close();
});

/** POST like `send_once` does: bearer auth, JSON body, no Anthropic headers. */
function post(body, headers = {}) {
  return fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer mock-key",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A valid body with `patch` layered over it (deep-cloned). */
function over(patch) {
  return { ...structuredClone(VALID_BODY), ...patch };
}

/** Split a streamed response into parsed chunks plus the terminal marker. */
async function readStream(res) {
  const text = await res.text();
  const lines = text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice("data: ".length));
  const done = lines[lines.length - 1];
  return { chunks: lines.slice(0, -1).map((l) => JSON.parse(l)), done, raw: text };
}

describe("GET /models", () => {
  it("serves the openai list shape with the three scenario ids", async () => {
    const res = await fetch(`${base}/models`, {
      headers: { authorization: "Bearer mock-key" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    const ids = body.data.map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining(["mock-text", "mock-artifact", "mock-question"]),
    );
    for (const m of body.data) {
      expect(m.object).toBe("model");
      expect(typeof m.id).toBe("string");
    }
  });
});

describe("POST /chat/completions — the strict wire", () => {
  it("streams a gemini-shaped sse turn: reasoning first, text after, [DONE] last", async () => {
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const { chunks, done } = await readStream(res);
    expect(done).toBe("[DONE]");
    const has = chunks.map((c) => c.choices[0].delta);
    expect(has.some((d) => typeof d.reasoning_content === "string")).toBe(
      true,
      "reasoning rides reasoning_content on this wire",
    );
    expect(has.some((d) => typeof d.content === "string")).toBe(true);
    const firstReasoning = has.findIndex((d) => d.reasoning_content);
    const firstText = has.findIndex((d) => d.content);
    expect(firstReasoning).toBeGreaterThanOrEqual(0);
    expect(firstReasoning).toBeLessThan(firstText);
    const last = chunks[chunks.length - 1];
    expect(last.choices[0].finish_reason).toBe("stop");
    expect(typeof last.usage.total_tokens).toBe("number");
    for (const c of chunks) {
      expect(c.object).toBe("chat.completion.chunk");
    }
  });

  it("refuses every anthropic leak by field name, and still accepts the clean body", async () => {
    const cases = [
      [over({ thinking: { type: "enabled", budget_tokens: 1024 } }), {}, "thinking"],
      [over({ context_management: {} }), {}, "context_management"],
      [over({ system: "leaked top-level system" }), {}, "system"],
      [over({ stream: false }), {}, "stream"],
      [over({ anthropic_version: "2023-06-01" }), {}, "unexpected"],
      [over({}), { "x-api-key": "sk-x" }, "x-api-key"],
      [over({}), { "anthropic-version": "2023-06-01" }, "anthropic-version"],
      [over({}), { "anthropic-beta": "beta-1" }, "anthropic-beta"],
      [
        over({ tools: [{ name: "fs", input_schema: { type: "object" } }] }),
        {},
        "input_schema",
      ],
      [over({ tool_choice: { type: "auto" } }), {}, "tool_choice"],
      [over({ max_tokens: 0 }), {}, "max_tokens"],
      [
        over({
          messages: [
            { role: "user", content: "hi" },
            { role: "system", content: "arrives late" },
          ],
        }),
        {},
        "first message",
      ],
      [
        over({
          messages: [
            ...VALID_BODY.messages,
            { role: "tool", tool_call_id: "call_orphan", content: "lost" },
          ],
        }),
        {},
        "call_orphan",
      ],
      [
        over({
          messages: [
            ...VALID_BODY.messages,
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "fs", arguments: { command: "read" } },
                },
              ],
            },
          ],
        }),
        {},
        "arguments",
      ],
    ];
    for (const [body, headers, needle] of cases) {
      const res = await post(body, headers);
      expect(res.status, `case ${needle} must be refused`).toBe(400);
      const err = await res.json();
      expect(err.error.message, `case ${needle}`).toContain(needle);
    }
    const clean = await post(VALID_BODY);
    expect(clean.status, "the clean body still passes").toBe(200);
    await clean.text();
  });

  it("requires the bearer authorization header", async () => {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(400);
    const err = await res.json();
    expect(err.error.message).toContain("authorization");
  });
});

describe("scenarios", () => {
  it("mock-artifact streams a stringified artifact tool call, then answers after the result", async () => {
    const first = await post(over({ model: "mock-artifact" }));
    expect(first.status).toBe(200);
    const { chunks, done } = await readStream(first);
    expect(done).toBe("[DONE]");
    const calls = chunks.flatMap((c) => c.choices[0].delta.tool_calls ?? []);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].function.name).toBe("artifact");
    expect(calls[0].id).toBe("call_mock_artifact");
    const arguments_ = chunks
      .map((c) => c.choices[0].delta.tool_calls?.[0]?.function?.arguments ?? "")
      .join("");
    const input = JSON.parse(arguments_);
    expect(input.title).toBe("Mock artifact");
    expect(input.mediaType).toBe("text/html");
    expect(input.source).toContain("<html>");
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("tool_calls");

    // Turn two: the app sends the tool result back; the mock answers plainly.
    const second = await post(
      over({
        model: "mock-artifact",
        messages: [
          ...VALID_BODY.messages,
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_mock_artifact",
                type: "function",
                function: { name: "artifact", arguments: arguments_ },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_mock_artifact",
            content: JSON.stringify({ ok: true }),
          },
        ],
      }),
    );
    expect(second.status).toBe(200);
    const secondStream = await readStream(second);
    const text = secondStream.chunks
      .map((c) => c.choices[0].delta.content ?? "")
      .join("");
    expect(text.length).toBeGreaterThan(0);
    expect(secondStream.chunks.at(-1).choices[0].finish_reason).toBe("stop");
  });

  it("mock-question streams a question tool call with a prompt and options", async () => {
    const first = await post(over({ model: "mock-question" }));
    expect(first.status).toBe(200);
    const { chunks } = await readStream(first);
    const arguments_ = chunks
      .map((c) => c.choices[0].delta.tool_calls?.[0]?.function?.arguments ?? "")
      .join("");
    const input = JSON.parse(arguments_);
    expect(chunks.flatMap((c) => c.choices[0].delta.tool_calls ?? [])[0].function.name).toBe(
      "question",
    );
    expect(typeof input.prompt).toBe("string");
    expect(input.prompt.length).toBeGreaterThan(0);
    expect(Array.isArray(input.options)).toBe(true);
    expect(input.options.length).toBeGreaterThanOrEqual(1);
  });

  it("unknown model ids still stream a plain text turn", async () => {
    const res = await post(over({ model: "whatever-custom" }));
    expect(res.status).toBe(200);
    const { done } = await readStream(res);
    expect(done).toBe("[DONE]");
  });
});

describe("control endpoints", () => {
  it("records requests for inspection and clears on reset", async () => {
    await (await post(VALID_BODY)).text();
    const log = await (await fetch(`${base}/__requests`)).json();
    expect(log.requests.length).toBe(1);
    expect(log.requests[0].body.model).toBe("mock-text");
    expect(log.requests[0].authorization).toBe("[redacted]");
    await fetch(`${base}/__reset`, { method: "POST" });
    const cleared = await (await fetch(`${base}/__requests`)).json();
    expect(cleared.requests.length).toBe(0);
  });
});
