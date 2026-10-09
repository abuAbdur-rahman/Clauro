// The localhost mock OpenAI-compatible server: the executable witness of the
// compat wire (D119), driven by the e2e harness.
//
// Why it exists: the real e2e needs a chat-completions endpoint that (1) is
// strictly honest — it refuses every Anthropic leak the translator must never
// send, by field name, so a routing regression fails loudly at the wire and
// never masquerades as a model answer — and (2) scripts the tool-call
// scenarios the shell must survive: a text turn with reasoning, an `artifact`
// tool call (fragmented arguments, `finish_reason: "tool_calls"`), and a
// `question` tool call that pauses the turn (D118).
//
// Wire style mirrors the recorded Gemini shape (Tasks/005): bare `data:`
// lines, terminal `data: [DONE]`, `usage` on the final chunk. Zero
// dependencies, loopback-only, never committed config — paste the printed URL
// into the Providers UI as a custom provider base URL.
//
// The scenario is chosen by the model id (`GET /models` lists all three), so
// the app needs no extra control channel: pick a model, get that script.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** The only top-level fields the translator may send. Anything else is a leak. */
const ALLOWED_KEYS = new Set([
  "model",
  "messages",
  "max_tokens",
  "stream",
  "tools",
  "tool_choice",
]);

/** Headers only the Anthropic wire may carry. */
const ANTHROPIC_HEADERS = ["x-api-key", "anthropic-version", "anthropic-beta"];

const SCENARIO_IDS = ["mock-text", "mock-artifact", "mock-question"];

const ARTIFACT_ARGS = {
  title: "Mock artifact",
  mediaType: "text/html",
  source:
    '<html><body style="font-family: sans-serif; padding: 1rem">' +
    "<h1>Mock artifact</h1><p>Rendered by the localhost mock server.</p>" +
    "</body></html>",
};

const QUESTION_ARGS = {
  prompt: "Which flavour should the mock use?",
  options: [
    { id: "vanilla", label: "Vanilla" },
    { id: "chocolate", label: "Chocolate" },
  ],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Validate one chat-completions request against the translated wire. Returns
 * human-readable violations; empty means the body is exactly what the
 * translator promises (D119: drop, never approximate — nothing approximated
 * may pass here either).
 */
export function validateChatRequest(headers, body) {
  const v = [];
  const contentType = headers["content-type"] ?? "";
  if (!contentType.includes("application/json")) {
    v.push(`content-type must be application/json, got "${contentType}"`);
  }
  const auth = headers["authorization"] ?? "";
  if (!auth.startsWith("Bearer ") || auth.length <= "Bearer ".length) {
    v.push("authorization must be a Bearer token on the compat wire");
  }
  for (const header of ANTHROPIC_HEADERS) {
    if (headers[header] !== undefined) {
      v.push(
        `${header} is anthropic-only and must not ride the compat wire (D119)`,
      );
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    v.push("body must be a JSON object");
    return v;
  }
  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(key)) {
      v.push(
        `unexpected top-level field "${key}" — the translator may only send: ` +
          [...ALLOWED_KEYS].join(", "),
      );
    }
  }
  if (body.stream !== true) {
    v.push(`stream must be true, got ${JSON.stringify(body.stream)}`);
  }
  if (typeof body.model !== "string" || body.model.length === 0) {
    v.push("model must be a non-empty string");
  }
  if (!Number.isInteger(body.max_tokens) || body.max_tokens <= 0) {
    v.push(`max_tokens must be a positive integer, got ${JSON.stringify(body.max_tokens)}`);
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    v.push("messages must be a non-empty array");
    return v;
  }

  // Roles, content shapes, tool-call pairing (D19 pairing survives assembly:
  // every tool message follows the assistant message holding its call).
  let openCalls = new Set();
  body.messages.forEach((message, i) => {
    const at = `messages[${i}]`;
    if (typeof message !== "object" || message === null) {
      v.push(`${at} must be an object`);
      return;
    }
    const role = message.role;
    if (!["system", "user", "assistant", "tool"].includes(role)) {
      v.push(`${at} role "${role}" is not a chat-completions role`);
      return;
    }
    if (role === "system") {
      if (i !== 0) {
        v.push(`${at} system must be the first message, not number ${i + 1}`);
      }
      if (typeof message.content !== "string") {
        v.push(`${at} system content must be a string`);
      }
      openCalls = new Set();
      return;
    }
    if (role === "tool") {
      const id = message.tool_call_id;
      if (typeof id !== "string" || id.length === 0) {
        v.push(`${at} tool messages need a tool_call_id`);
      } else if (!openCalls.has(id)) {
        v.push(
          `${at} tool_call_id "${id}" does not follow the assistant message holding that call`,
        );
      } else {
        openCalls.delete(id);
      }
      if (typeof message.content !== "string") {
        v.push(`${at} tool content must be a string`);
      }
      return;
    }
    if (typeof message.content !== "string") {
      if (role === "user") {
        v.push(`${at} user content must be a string`);
      } else if (message.content !== null && message.content !== undefined) {
        v.push(`${at} ${role} content must be a string`);
      } else if (!Array.isArray(message.tool_calls)) {
        v.push(`${at} ${role} content must be a string`);
      }
    }
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      const ids = [];
      message.tool_calls.forEach((call, j) => {
        const atCall = `${at}.tool_calls[${j}]`;
        if (typeof call?.id !== "string" || call.id.length === 0) {
          v.push(`${atCall} needs an id`);
        } else {
          ids.push(call.id);
        }
        if (call?.type !== "function") {
          v.push(`${atCall} type must be "function"`);
        }
        if (typeof call?.function?.name !== "string" || call.function.name.length === 0) {
          v.push(`${atCall} needs function.name`);
        }
        if (typeof call?.function?.arguments !== "string") {
          v.push(
            `${atCall} function.arguments must be a JSON string, got ${typeof call?.function?.arguments}`,
          );
        } else {
          try {
            JSON.parse(call.function.arguments);
          } catch {
            v.push(`${atCall} function.arguments is not parseable JSON`);
          }
        }
      });
      openCalls = new Set(ids);
    } else if (message.tool_calls !== undefined) {
      v.push(`${at} tool_calls may only ride an assistant message`);
      openCalls = new Set();
    } else {
      openCalls = new Set();
    }
  });

  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) {
      v.push("tools must be an array");
    } else {
      body.tools.forEach((tool, i) => {
        const at = `tools[${i}]`;
        if (JSON.stringify(tool).includes("input_schema")) {
          v.push(
            `${at} input_schema is the anthropic field; this wire uses function.parameters`,
          );
        }
        if (tool?.type !== "function") {
          v.push(`${at} type must be "function"`);
        }
        if (typeof tool?.function?.name !== "string" || tool.function.name.length === 0) {
          v.push(`${at} needs function.name`);
        }
        const parameters = tool?.function?.parameters;
        if (
          typeof parameters !== "object" ||
          parameters === null ||
          Array.isArray(parameters)
        ) {
          v.push(`${at} needs function.parameters as a schema object`);
        }
      });
    }
  }

  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice;
    const bareString =
      typeof choice === "string" && ["auto", "none", "required"].includes(choice);
    const functionForm =
      typeof choice === "object" &&
      choice !== null &&
      choice.type === "function" &&
      typeof choice.function?.name === "string";
    if (!bareString && !functionForm) {
      v.push(
        `tool_choice must be "auto"/"none"/"required" or a function object, got ${JSON.stringify(choice)}`,
      );
    }
  }

  return v;
}

const chunkBase = (model) => ({
  id: "chatcmpl-mock",
  object: "chat.completion.chunk",
  created: 1,
  model,
});

const deltaChunk = (model, delta) => ({
  ...chunkBase(model),
  choices: [{ index: 0, delta, finish_reason: null }],
});

const finishChunk = (model, finishReason) => ({
  ...chunkBase(model),
  choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  usage: { prompt_tokens: 12, completion_tokens: 18, total_tokens: 30 },
});

/** A tool-call turn: id+name first, argument fragments after (both framings). */
function toolCallChunks(model, id, name, args) {
  const encoded = JSON.stringify(args);
  const third = Math.ceil(encoded.length / 3);
  const fragments = [
    encoded.slice(0, third),
    encoded.slice(third, 2 * third),
    encoded.slice(2 * third),
  ];
  return [
    deltaChunk(model, {
      tool_calls: [
        { index: 0, id, type: "function", function: { name, arguments: "" } },
      ],
    }),
    ...fragments.map((fragment) =>
      deltaChunk(model, {
        tool_calls: [
          {
            index: 0,
            function: { arguments: fragment },
          },
        ],
      }),
    ),
    finishChunk(model, "tool_calls"),
  ];
}

const TEXT_CHUNKS = (model) => [
  deltaChunk(model, { reasoning_content: "Checking the request shape. " }),
  deltaChunk(model, { reasoning_content: "All required fields are present. " }),
  deltaChunk(model, { content: "The mock server received your turn. " }),
  deltaChunk(model, { content: "Wire shape verified." }),
  finishChunk(model, "stop"),
];

/**
 * Pick the scripted chunks for one request. The last message decides the
 * turn: a `tool` message means the app executed the previous call, so the
 * script answers plainly instead of re-issuing the call.
 */
function scriptFor(model, messages) {
  const last = messages[messages.length - 1];
  const answered = last?.role === "tool";
  if (model === "mock-artifact") {
    if (answered) {
      return [
        deltaChunk(model, {
          content: "Artifact rendered. The drawer should now be showing it.",
        }),
        finishChunk(model, "stop"),
      ];
    }
    return toolCallChunks(model, "call_mock_artifact", "artifact", ARTIFACT_ARGS);
  }
  if (model === "mock-question") {
    if (answered) {
      return [
        deltaChunk(model, { content: "Question answered. The card flow works." }),
        finishChunk(model, "stop"),
      ];
    }
    return toolCallChunks(model, "call_mock_question", "question", QUESTION_ARGS);
  }
  return TEXT_CHUNKS(model);
}

const modelsBody = () => ({
  object: "list",
  data: SCENARIO_IDS.map((id) => ({
    id,
    object: "model",
    created: 0,
    owned_by: "clauro-mock",
  })),
});

const openAiError = (message, code = "invalid_request_error") => ({
  error: { message, type: "invalid_request_error", param: null, code },
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 4 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

/**
 * Start the mock on loopback. `port: 0` picks an ephemeral port; `url` is the
 * base URL to paste into the Providers UI. `requests` records every call with
 * the authorization value redacted (no token, real or fake, ever lands in a
 * log). Control endpoints: `GET /__requests`, `POST /__reset`,
 * `POST /__shutdown`.
 */
export function startMockServer({ port = 0, delayMs = 5 } = {}) {
  const requests = [];

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify(openAiError(String(error?.message ?? error), "server_error")));
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = url.pathname.replace(/\/+$/, "") || "/";

    if (route.endsWith("/__requests")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ requests }));
      return;
    }
    if (route.endsWith("/__reset") && req.method === "POST") {
      requests.length = 0;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (route.endsWith("/__shutdown") && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      server.close();
      return;
    }

    if (req.method === "GET" && route.endsWith("/models")) {
      requests.push({
        method: "GET",
        path: route,
        authorization: "[redacted]",
        body: null,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(modelsBody()));
      return;
    }

    if (req.method === "POST" && route.endsWith("/chat/completions")) {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify(openAiError("body is not valid JSON")));
        return;
      }
      const violations = validateChatRequest(req.headers, body);
      requests.push({
        method: "POST",
        path: route,
        authorization: "[redacted]",
        body,
        violations,
      });
      if (violations.length > 0) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            openAiError(`wire violation: ${violations.join("; ")}`),
          ),
        );
        return;
      }

      const chunks = scriptFor(body.model, body.messages);
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const chunk of chunks) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        await sleep(delayMs);
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify(openAiError(`no route for ${req.method} ${route}`, "not_found")));
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${bound}/v1`,
        requests,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

const isCli =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  const port = Number(process.argv[2] ?? 8787);
  const { url } = await startMockServer({ port });
  console.log(`clauro mock openai server listening on ${url}`);
  console.log(`add it in Providers as a custom provider base URL: ${url}`);
}
