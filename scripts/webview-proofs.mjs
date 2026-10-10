/**
 * Webview security proofs (Tasks/013 five criteria + D122's handshake chain).
 *
 * Drives the REAL bundled app through the production pipeline — no test hooks:
 * a seeded artifact row in the app-data store is fetched by the drawer's
 * producer (D121), prepared by the real envelope (D3/D12), published through
 * `artifact_publish` and rendered in the frame from its served document
 * (D123); the handshake then completes end to end (D122).
 *
 * Order matters: the render proof and claims 1–4 depend only on the document
 * that arrived, so they run before the handshake wait — a stalled handshake
 * still leaves the transport facts on record. Only claim 5 needs `ready`.
 *
 * Zero-dependency: raw W3C WebDriver over fetch against tauri-driver, which
 * wraps msedgedriver (version-matched to the WebView2 runtime).
 *
 * Usage: pnpm proofs   (needs target/debug/clauro.exe and target/webdriver/msedgedriver.exe)
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const DRIVER_PORT = 4444;
const NATIVE_PORT = 4445;
const APPDATA = process.env.APPDATA ?? "";
const APP_DIR = join(APPDATA, "app.clauro");
const DB_PATH = join(APP_DIR, "clauro.db");
const SESSION_DIR = join(APP_DIR, "sessions", "thread-001");
const SOURCE_REL = "artifacts/proof-1-1/source";
const SEED_SOURCE = '<h1>Artifact proof</h1><p id="proof-target">PROOF-OK</p>';
const APP_BIN = resolve("target/debug/clauro.exe");
const NATIVE_DRIVER = resolve("target/webdriver/msedgedriver.exe");
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

/** @type {{ name: string, pass: boolean, detail: string }[]} */
const claims = [];
let sessionId = null;
let driver = null;

function claim(name, pass, detail) {
  claims.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function fatal(message) {
  console.error(`FATAL: ${message}`);
  cleanup(1);
}

function cleanup(code) {
  try {
    if (sessionId) {
      spawnSync("curl.exe", ["-s", "-X", "DELETE", `http://127.0.0.1:${DRIVER_PORT}/session/${sessionId}`], { timeout: 15000 });
    }
  } catch { /* best effort: the driver may already be gone */ }
  if (driver && driver.exitCode === null) {
    // Kill the whole tree: tauri-driver spawns msedgedriver, which spawns WebView2.
    spawnSync("taskkill.exe", ["/pid", String(driver.pid), "/T", "/F"], { timeout: 15000 });
  }
  if (code) process.exit(code);
}

process.on("exit", () => cleanup(0));
process.on("SIGINT", () => cleanup(130));

async function wd(method, path, body, timeoutMs = 30000) {
  const res = await fetch(`http://127.0.0.1:${DRIVER_PORT}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => ({ value: { error: `non-JSON response (${res.status})` } }));
  const value = json.value;
  if (!res.ok || (value && value.error)) {
    throw new Error(`${method} ${path} failed: ${JSON.stringify(value)}`);
  }
  return value;
}

function execSyncScript(script, timeoutMs = 15000) {
  return wd("POST", `/session/${sessionId}/execute/sync`, { script, args: [] }, timeoutMs);
}

function execAsyncScript(script, timeoutMs = 15000) {
  return wd("POST", `/session/${sessionId}/execute/async`, { script, args: [] }, timeoutMs);
}

async function findElement(selector) {
  const value = await wd("POST", `/session/${sessionId}/element`, { using: "css selector", value: selector });
  return value[ELEMENT_KEY];
}

async function switchFrame(target) {
  // `target` is an element id, or null for the top-level context.
  const id = target === null ? null : { [ELEMENT_KEY]: target };
  await wd("POST", `/session/${sessionId}/frame`, { id });
}

async function waitUntil(fn, what, timeoutMs, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for ${what}${lastError ? ` (last error: ${lastError})` : ""}`);
}

/** Where did the handshake chain stop? Frame-side facts, then shell-side. */
async function handshakeDiagnostics() {
  try {
    await switchFrame(await findElement('iframe[title="artifact-frame"]'));
    const meta = await execSyncScript(
      "var m = document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]');" +
      "return m ? m.getAttribute('content') : null;",
    );
    const scriptInfo = await execSyncScript(
      "var s = document.querySelector('script');" +
      "return JSON.stringify({ count: document.querySelectorAll('script').length," +
      " nonce: s ? s.nonce : null, len: s ? s.textContent.length : -1 });",
    );
    // Attach a violation recorder, then force two fresh inline-script CSP
    // checks: one carrying the meta policy's nonce, one without (control —
    // must always violate if CSP is enforced at all). Each blocking policy
    // reports separately, so `violatedPolicy` names the enforcer verbatim.
    const probe = await execAsyncScript(
      "var done = arguments[arguments.length - 1];" +
      "var log = [];" +
      "document.addEventListener('securitypolicyviolation', function (e) {" +
      "  log.push({ dir: e.effectiveDirective, policy: String(e.violatedPolicy).slice(0, 300) });" +
      "});" +
      "var m = document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]');" +
      "var n = (m && m.content.match(/'nonce-([^']+)'/)) || [];" +
      "var withNonce = document.createElement('script');" +
      "if (n[1]) { withNonce.setAttribute('nonce', n[1]); withNonce.nonce = n[1]; }" +
      "withNonce.textContent = 'window.__probeWithNonce = 1;';" +
      "document.body.appendChild(withNonce);" +
      "var noNonce = document.createElement('script');" +
      "noNonce.textContent = 'window.__probeNoNonce = 1;';" +
      "document.body.appendChild(noNonce);" +
      "setTimeout(function () {" +
      "  done(JSON.stringify({ withNonce: typeof window.__probeWithNonce," +
      "    noNonce: typeof window.__probeNoNonce, violations: log }));" +
      "}, 400);",
    );
    const runtimeAfter = await execSyncScript("return typeof window.__clauroArtifact;");
    await switchFrame(null);
    // Shell facts needed to weigh transport fixes: the real origin and
    // whether Tauri injected a nonce-bearing tag we could observe (D78).
    const shellInfo = await execSyncScript(
      "return JSON.stringify({ url: location.href," +
      " scripts: Array.prototype.map.call(document.querySelectorAll('script'), function (s) {" +
      "  return { src: s.src, nonce: s.nonce }; }) });",
    );
    const attr = await execSyncScript(
      "var f = document.querySelector('iframe[title=\"artifact-frame\"]');" +
      "return f ? f.getAttribute('data-artifact-channel') : null;",
    );
    // Fix-option facts: does the INHERITED policy's 'self' match a
    // parent-origin URL, and does it match a parent-created blob: URL?
    // The probe frame gets no meta CSP of its own, so only the inherited
    // policy applies. Two nested iframes: about:blank (control, must load)
    // and a shell-origin URL (loads iff 'self' matches the parent origin —
    // both are counted by cross-origin-readable window.length). The blob
    // script signals execution by postMessage to the shell.
    const cspFacts = await execAsyncScript(
      "var done = arguments[arguments.length - 1];" +
      "var gotBlob = false;" +
      "window.addEventListener('message', function onmsg(e) {" +
      "  if (e.data && e.data.probe === 'blob-ok') {" +
      "    gotBlob = true; window.removeEventListener('message', onmsg);" +
      "  }" +
      "});" +
      "var blobUrl = URL.createObjectURL(new Blob(" +
      "  [\"window.parent.postMessage({ probe: 'blob-ok' }, '*');\"]," +
      "  { type: 'text/javascript' }));" +
      "var p = document.createElement('iframe');" +
      "p.setAttribute('sandbox', 'allow-scripts');" +
      "p.srcdoc = '<iframe src=\"about:blank\"></iframe>' +" +
      "  '<iframe src=\"http://tauri.localhost/__csp-probe\"></iframe>' +" +
      "  '<script src=\"' + blobUrl + '\"></scr' + 'ipt>';" +
      "document.body.appendChild(p);" +
      "setTimeout(function () {" +
      "  var frames = -1;" +
      "  try { frames = p.contentWindow.length; } catch (e) { frames = 'err:' + e.name; }" +
      "  URL.revokeObjectURL(blobUrl); p.remove();" +
      "  done(JSON.stringify({ nestedFrames: frames, blobRan: gotBlob }));" +
      "}, 1200);",
      20000,
    );
    console.error(`handshake diagnostics:
  frame meta CSP: ${meta}
  frame script:   ${scriptInfo}
  clone probe:    ${probe}
  runtime after clone: ${runtimeAfter}
  shell:          ${shellInfo}
  csp fix facts:  ${cspFacts}
  channel attr:   ${JSON.stringify(attr)}`);
  } catch (e) {
    console.error(`handshake diagnostics failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** Seed the app-data store through sqlite3, retried against a hot DB. */
function seedStore() {
  const sql = [
    "INSERT OR IGNORE INTO thread (id, project_id, title, incognito, memory_off, system_frozen, tools_frozen, created_at)" +
      " VALUES ('thread-001', NULL, 'Proof thread', 0, 0, '', '[]', 1770000000000);",
    // created_at in 2100 so the proof row is always the thread's newest.
    "INSERT OR REPLACE INTO artifact (id, thread_id, version, title, media_type, source_path, compiled_path, created_at)" +
      " VALUES ('proof-1', 'thread-001', 1, 'Proof', 'text/html', 'artifacts/proof-1-1/source', NULL, 4102444800000);",
  ].join("\n");
  let last = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const run = spawnSync("sqlite3.exe", [DB_PATH], { input: sql, encoding: "utf8", timeout: 15000 });
    if (run.status === 0) return;
    last = run.stderr || `exit ${run.status}`;
    spawnSync("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 500"], { timeout: 5000 });
  }
  throw new Error(`sqlite3 seed failed: ${last}`);
}

async function main() {
  // ── Preflight ──────────────────────────────────────────────────────────
  for (const [path, what] of [
    [APP_BIN, "the debug app build (pnpm tauri build --debug --no-bundle)"],
    [NATIVE_DRIVER, "msedgedriver (version-matched to the WebView2 runtime)"],
  ]) {
    if (!existsSync(path)) fatal(`missing ${path} — run the ${what} first`);
  }

  // The artifact's source bytes, written before launch: the producer reads
  // them from disk through the session root, exactly as the tool would.
  mkdirSync(join(SESSION_DIR, "artifacts", "proof-1-1"), { recursive: true });
  writeFileSync(join(SESSION_DIR, SOURCE_REL), SEED_SOURCE, "utf8");

  // ── tauri-driver + session ─────────────────────────────────────────────
  driver = spawn("tauri-driver", [
    "--port", String(DRIVER_PORT),
    "--native-port", String(NATIVE_PORT),
    "--native-driver", NATIVE_DRIVER,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  driver.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) console.error(`[tauri-driver] ${text}`);
  });

  await waitUntil(
    async () => (await fetch(`http://127.0.0.1:${DRIVER_PORT}/status`, { signal: AbortSignal.timeout(3000) })).ok,
    "tauri-driver to come up on port 4444",
    45000,
  );

  const session = await wd("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "wry",
        "tauri:options": { application: APP_BIN },
      },
    },
  }, 120000);
  sessionId = session[ELEMENT_KEY] ?? session.sessionId;
  if (!sessionId) throw new Error(`no sessionId in session response: ${JSON.stringify(session)}`);
  console.log(`session ${sessionId}`);

  // ── boot, seed, navigate ───────────────────────────────────────────────
  await waitUntil(
    () => execSyncScript("return document.body && document.body.innerText.indexOf('Browse projects') !== -1;"),
    "the app shell to render the home view",
    60000,
  );
  console.log("app booted");

  seedStore();
  console.log("store seeded (thread-001 / artifact proof-1)");

  await waitUntil(async () => {
    const nav = await execSyncScript(
      "var ts = Array.prototype.filter.call(document.querySelectorAll('button'), function (b) { return b.textContent.trim() === 'First thread'; });" +
      "if (ts.length) { ts[0].click(); return 'thread'; }" +
      "var ps = Array.prototype.filter.call(document.querySelectorAll('button'), function (b) { return b.textContent.trim() === 'Default'; });" +
      "if (ps.length) { ps[0].click(); return 'project'; }" +
      "return 'none';",
    );
    return nav !== "none";
  }, "the rail's thread button", 30000);

  const frameElement = await waitUntil(
    () => findElement('iframe[title="artifact-frame"]').catch(() => null),
    "the artifact frame (producer → prepare → publish)",
    90000,
  );
  console.log("artifact frame rendered through the production pipeline");
  void frameElement;

  // ── render proof + claims 1–4: document facts, no channel needed ──────
  // These depend only on the document that arrived (D123), never on the
  // handshake, so they run first: with `src` transport the document loads
  // asynchronously, and a stalled handshake must not hide the transport
  // facts from the report.
  await switchFrame(await findElement('iframe[title="artifact-frame"]'));

  const rendered = await waitUntil(
    () => execSyncScript(
      "var t = document.getElementById('proof-target'); return t ? t.textContent : null;",
    ).then((v) => (v === "PROOF-OK" ? v : null)),
    "the seeded bytes to render inside the served document",
    30000,
  );
  claim("artifacts render live: the frame shows the seeded bytes",
    rendered === "PROOF-OK", `proof-target=${JSON.stringify(rendered)}`);

  // ── claims 1–4, probed from inside the real frame ──────────────────────
  // The context is already the frame (switched above for the render proof,
  // and nothing since has left it) and the document has arrived, so these
  // are answerable regardless of handshake state.
  // ── claim 1: the frame's internals are present but inert (D124) ────────
  // wry's WebView2 backend injects the host init scripts into every frame —
  // it ignores `for_main_frame_only` — so the frame owns a
  // `__TAURI_INTERNALS__` object. Absence is unachievable on this floor; the
  // proven property is inertness instead. The document host is remote to
  // Tauri's IPC by construction and no capability grants a remote context
  // (both pinned in `artifact_doc`'s tests), so an invoke from the frame must
  // fail closed at the host's ACL check while the shell's own invoke works.
  const internals = await execSyncScript(
    "return JSON.stringify({ type: typeof window.__TAURI_INTERNALS__," +
    " keys: window.__TAURI_INTERNALS__ ? Object.keys(window.__TAURI_INTERNALS__) : []," +
    " invoke: typeof (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke)," +
    " ipc: typeof window.ipc });",
  );
  const surface = JSON.parse(internals);
  let claim1Pass = false;
  let claim1Detail = `surface=${internals}`;
  if (surface.type === "undefined") {
    claim1Pass = true;
    claim1Detail += " — absent outright (stronger than D124 needs)";
  } else if (surface.invoke !== "function") {
    // An internals object with no invoke entry cannot reach a command.
    claim1Pass = true;
    claim1Detail += " — no invoke entry, no command path";
  } else {
    // invoke exists: attempt a harmless command from the frame. It must never
    // resolve — the host rejects it (remote origin, no remote capabilities).
    // Frame-side a rejection and a lost response both read as a hang, so the
    // shell runs the same invoke as a positive control: IPC itself works.
    const frameAttempt = await execAsyncScript(
      "var done = arguments[arguments.length - 1];" +
      "var t = setTimeout(function () { done('unresolved'); }, 8000);" +
      "try {" +
      "  window.__TAURI_INTERNALS__.invoke('webview_status').then(" +
      "    function (v) { clearTimeout(t); done('resolved:' + JSON.stringify(v)); }," +
      "    function (e) { clearTimeout(t); done('rejected:' + String((e && e.message) || e)); });" +
      "} catch (e) { clearTimeout(t); done('threw:' + e.name); }",
      15000,
    );
    await switchFrame(null);
    const shellControl = await execAsyncScript(
      "var done = arguments[arguments.length - 1];" +
      "var t = setTimeout(function () { done('unresolved'); }, 8000);" +
      "try {" +
      "  window.__TAURI_INTERNALS__.invoke('webview_status').then(" +
      "    function (v) { clearTimeout(t); done('resolved:' + (v && typeof v)); }," +
      "    function (e) { clearTimeout(t); done('rejected:' + String((e && e.message) || e)); });" +
      "} catch (e) { clearTimeout(t); done('threw:' + e.name); }",
      15000,
    );
    await switchFrame(await findElement('iframe[title="artifact-frame"]'));
    claim1Pass = frameAttempt === "unresolved" && shellControl.startsWith("resolved:");
    claim1Detail += ` — frame invoke ${frameAttempt}, shell control ${shellControl}`;
  }
  claim("claim 1: the frame cannot reach a host command (D124: present but inert)",
    claim1Pass, claim1Detail);

  const viaParent = await execSyncScript(
    "try { var api = window.parent.__TAURI_INTERNALS__; return api === undefined ? 'undefined' : 'reachable'; }" +
    "catch (e) { return 'throws:' + e.name; }",
  );
  claim("claim 1b: no path to the shell's Tauri internals through the parent",
    viaParent === "undefined" || viaParent.startsWith("throws:"), `parent access=${viaParent}`);

  const parentDoc = await execSyncScript(
    "try { void window.parent.document; return 'readable'; } catch (e) { return 'refused:' + e.name; }",
  );
  claim("claim 2: parent.document access is refused",
    parentDoc.startsWith("refused:"), parentDoc);

  const origin = await execAsyncScript(
    "var done = arguments[arguments.length - 1];" +
    "window.addEventListener('message', function handler(e) {" +
    "  if (e.data && e.data.type === '__proof-origin') {" +
    "    window.removeEventListener('message', handler); done(e.origin);" +
    "  }" +
    "});" +
    "window.postMessage({ type: '__proof-origin' }, '*');",
  );
  claim("claim 3: event.origin from the frame is \"null\"",
    origin === "null", `origin=${JSON.stringify(origin)}`);

  const fetchResult = await execAsyncScript(
    "var done = arguments[arguments.length - 1];" +
    "fetch('http://127.0.0.1:9/ping').then(function () { done('reached'); }, function (e) { done('failed:' + (e && e.name)); });",
  );
  claim("claim 4: a network request from inside the frame fails",
    fetchResult.startsWith("failed:"), fetchResult);

  // The handshake chain (D122), observed from the shell side — after the
  // document facts, so a stalled handshake never hides them from the report.
  // Recorded rather than thrown: claim 5 below is the only one that needs it.
  await switchFrame(null);
  let handshakeReady = false;
  try {
    await waitUntil(
      async () => {
        const attr = await execSyncScript(
          "var f = document.querySelector('iframe[title=\"artifact-frame\"]');" +
          "return f ? f.getAttribute('data-artifact-channel') : null;",
        );
        return attr === "ready";
      },
      "the handshake chain to reach ready (D122)",
      30000,
    );
    handshakeReady = true;
  } catch {
    // Recorded as a failed claim below; diagnostics already printed.
    await handshakeDiagnostics();
  }
  claim("handshake chain completes in the engine (hello → validated → boot+port → ready)",
    handshakeReady,
    handshakeReady
      ? "data-artifact-channel=ready observed on the real frame"
      : "handshake never reached ready — see diagnostics above");

  // Claim 5: a refused handshake leaves the frame inert, not broken.
  await switchFrame(await findElement('iframe[title="artifact-frame"]'));
  await execSyncScript(
    "window.__proofBoots = 0;" +
    "window.addEventListener('message', function (e) {" +
    "  if (e.data && e.data.type === 'artifact.boot') window.__proofBoots += 1;" +
    "});" +
    "return 'armed';",
  );
  await switchFrame(null);
  await execSyncScript(
    "document.querySelector('iframe[title=\"artifact-frame\"]').contentWindow.postMessage({ type: 'artifact.hello' }, '*');" +
    "return 'forged';",
  );
  await switchFrame(await findElement('iframe[title="artifact-frame"]'));
  await new Promise((r) => setTimeout(r, 500));
  const forged = await execSyncScript(
    "var t = document.getElementById('proof-target');" +
    "return JSON.stringify({ boots: window.__proofBoots, alive: t ? t.textContent : null });",
  );
  const forgedState = JSON.parse(forged);
  await switchFrame(null);
  const stillReady = await execSyncScript(
    "return document.querySelector('iframe[title=\"artifact-frame\"]').getAttribute('data-artifact-channel');",
  );
  claim("claim 5: a refused handshake leaves the frame inert, not broken",
    forgedState.boots === 0 && forgedState.alive === "PROOF-OK" && stillReady === "ready",
    `boots=${forgedState.boots}, alive=${JSON.stringify(forgedState.alive)}, channel=${stillReady}`);

  // ── report ─────────────────────────────────────────────────────────────
  const failed = claims.filter((c) => !c.pass);
  writeFileSync(
    resolve("target/webdriver/proofs-report.json"),
    JSON.stringify({ date: new Date().toISOString(), app: APP_BIN, claims }, null, 2),
    "utf8",
  );
  console.log(`\n${claims.length - failed.length}/${claims.length} claims proven — report at target/webdriver/proofs-report.json`);
  cleanup(failed.length ? 1 : 0);
}

main().catch((e) => fatal(e instanceof Error ? (e.stack ?? e.message) : String(e)));
