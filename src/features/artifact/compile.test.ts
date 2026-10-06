import { describe, expect, it, vi } from "vitest";
import { transformJsx } from "./compile.transform";
// Source of these two modules, as text. Reading them through the bundler keeps
// the test off `node:fs`, which this project does not type (see `vite.config.ts`).
import HOST_SOURCE from "./compile.ts?raw";
import WORKER_SOURCE from "./compile.worker.ts?raw";
import {
  COMPILE_TIMEOUT_MS,
  COMPILED_MAX_BYTES,
  compileBlocks,
  extractJsxBlocks,
  type WorkerLike,
} from "./compile";

/**
 * A6/D4: an artifact that hangs, throws, or is enormous must not take the host
 * with it. The transform runs in a Worker behind a timeout and an output cap,
 * and every one of those failures is a typed outcome rather than an exception
 * crossing the tool boundary.
 */

const BLOCK_OPEN = '<script type="text/jsx">';
const BLOCK_CLOSE = "</script>";

/** A worker that does nothing until the test drives it. */
function idle(): WorkerLike {
  return { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null };
}

/** A worker that never answers: an infinite loop looks exactly like this. */
function silent(): WorkerLike {
  return { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null };
}

describe("jsx block extraction", () => {
  it("separates jsx blocks from the markup that stays literal", () => {
    const src = `<h1>static</h1>${BLOCK_OPEN}export default () => <p>live</p>${BLOCK_CLOSE}`;
    const { markup, blocks } = extractJsxBlocks(src);
    expect(blocks).toEqual(["export default () => <p>live</p>"]);
    expect(markup).toContain("<h1>static</h1>");
    expect(markup).not.toContain("text/jsx");
  });

  it("leaves a source with no blocks untouched", () => {
    const src = "<h1>plain html</h1>";
    expect(extractJsxBlocks(src)).toEqual({ markup: src, blocks: [] });
  });

  it("treats an unterminated block as markup rather than an unterminated promise", () => {
    const src = `<h1>x</h1>${BLOCK_OPEN}export default () => <p>`;
    expect(extractJsxBlocks(src)).toEqual({ markup: src, blocks: [] });
  });

  it("an artifact with no jsx never starts a worker", async () => {
    const createWorker = vi.fn(() => idle());
    const out = await compileBlocks([], {
      createWorker,
      timeoutMs: 50,
      maxBytes: COMPILED_MAX_BYTES,
    });
    expect(out).toEqual({ kind: "ok", blocks: [] });
    expect(createWorker).not.toHaveBeenCalled();
  });
});

describe("sucrase transform (D4)", () => {
  it("compiles jsx to the host h() pragma, not to a runtime", () => {
    const code = transformJsx(`export default () => <h1 className="text-xl">{1 + 1}</h1>`);
    expect(code.kind).toBe("ok");
    if (code.kind === "ok") {
      // The pragma is ours (D110). No React, no jsx-dev runtime, nothing that
      // would have to be shipped inside the sandbox.
      expect(code.code).toContain("h(");
      expect(code.code).not.toContain("React.createElement");
      expect(code.code).not.toContain("jsxDEV");
    }
  });

  it("strips typescript types when they are used", () => {
    const code = transformJsx(
      `export default function App(): unknown { const n: number = 2; return <b>{n}</b>; }`,
    );
    if (code.kind !== "ok") throw new Error("expected ok");
    expect(code.code).toContain("h(");
    expect(code.code).not.toContain(": unknown");
  });

  it("reports a syntax error as a value, never as a thrown exception", () => {
    const out = transformJsx("export default () => <div");
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.message).toMatch(/\S/);
  });
});

describe("worker boundary: timeout and cap (D4, A6)", () => {
  it("a worker that never answers times out, and is terminated", async () => {
    const w = silent();
    const out = await compileBlocks(["export default () => <b>hi</b>"], {
      createWorker: () => w,
      timeoutMs: 20,
      maxBytes: COMPILED_MAX_BYTES,
    });
    expect(out).toEqual({ kind: "timeout" });
    expect(w.terminate).toHaveBeenCalledOnce();
  });

  it("compiled output over the cap is refused with a clear message", async () => {
    // A worker that answers, with more output than the cap allows.
    const w = transformBackedWorker();
    const out = await compileBlocks(["export default () => <b>hi</b>"], {
      createWorker: () => w,
      timeoutMs: 100,
      maxBytes: 8,
    });
    expect(out.kind).toBe("too-big");
    if (out.kind === "too-big") expect(out.message).toMatch(/cap/i);
  });

  it("a failing worker is an error outcome, not an exception", async () => {
    const out = await compileBlocks(["a"], {
      createWorker: () => {
        const w = idle();
        queueMicrotask(() => {
          w.onerror?.({ message: "boom" });
        });
        return w;
      },
      timeoutMs: 100,
      maxBytes: COMPILED_MAX_BYTES,
    });
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.message).toContain("boom");
  });

  it("one bad block fails the artifact; no partial result is returned", async () => {
    const out = await compileBlocks(
      ["export default () => <b>a</b>", "export default () => <"],
      {
        createWorker: () => {
          const w = idle();
          queueMicrotask(() => {
            w.onerror?.({ message: "syntax error" });
          });
          return w;
        },
        timeoutMs: 100,
        maxBytes: COMPILED_MAX_BYTES,
      },
    );
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.message).toContain("syntax error");
  });
});

describe("a real compile through the real transform", () => {
  it("produces executable code for a jsx artifact", async () => {
    const out = await compileBlocks(["export default () => <b>hi</b>"], {
      createWorker: () => transformBackedWorker(),
      timeoutMs: 5000,
      maxBytes: COMPILED_MAX_BYTES,
    });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.blocks[0]).toContain("h(");
  });
});

describe("limits", () => {
  it("are exported and sized deliberately", () => {
    expect(COMPILED_MAX_BYTES).toBe(1024 * 1024);
    expect(COMPILE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(COMPILE_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });
});

describe("the import graph keeps Sucrase out of the host (D4)", () => {
  /** Comments are stripped: both modules *discuss* the rule in prose. */
  const codeOf = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the host half imports nothing at all", () => {
    const imports = [...codeOf(HOST_SOURCE).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports).not.toContain("sucrase");
    expect(imports).toEqual([]);
  });

  it("only the worker reaches the transform module", () => {
    expect(codeOf(WORKER_SOURCE)).toMatch(/from "\.\/compile\.transform"/);
    expect(codeOf(HOST_SOURCE)).not.toMatch(/compile\.transform/);
  });
});

/**
 * Runs the same transform the worker file runs. Node has no DOM Worker, so the
 * thread itself is not exercised here; the message contract and every decision
 * taken off it are.
 */
function transformBackedWorker(): WorkerLike {
  const w = idle();
  w.postMessage = (message: unknown) => {
    const source = (message as { source: string }).source;
    queueMicrotask(() => {
      const out = transformJsx(source);
      if (out.kind === "error") w.onerror?.({ message: out.message });
      else w.onmessage?.({ data: { kind: "ok", code: out.code } });
    });
  };
  return w;
}