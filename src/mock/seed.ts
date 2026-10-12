/**
 * Mock SEED — verbatim TS port of docs/references/ui/index.html:279-335
 * (Task 029). Mock mode only; real must never import `@/mock/*`
 * (shell.mockmode test). Data shapes mirror the prototype one-to-one so the
 * mock UI sits in the same state as the html.
 */

export const APP_NAME = "Clauro" as const;
export const DAY = 86_400_000;

export const R_SHORT =
  "Short answer: yes. Treat it as a small, focused change rather than a rewrite. Start with the simplest version that works, check it against one real example, then tighten it. If you share more detail, I can get specific.";

export const R_LIST = [
  "Here are the main trade-offs to weigh:",
  "",
  "- **Speed:** local models respond fast but have smaller context.",
  "- **Cost:** hosted APIs bill per token, so long chats add up.",
  "- **Privacy:** your keys stay on your device in this design.",
  "",
  "| Option | Context | Best for |",
  "|---|---|---|",
  "| Hosted API | 128k-200k | Hard reasoning |",
  "| Local model | 8k-32k | Offline drafts |",
  "",
  "Tell me which matters most and I will narrow it down.",
].join("\n");

export const R_CODE = [
  "Here is a small debounce helper:",
  "",
  "```js",
  "function debounce(fn, wait = 300) {",
  "  let t;",
  "  return (...args) => {",
  "    clearTimeout(t);",
  "    t = setTimeout(() => fn(...args), wait);",
  "  };",
  "}",
  "",
  'const onSearch = debounce(q => console.log("search", q), 250);',
  "```",
  "",
  "It delays the call until typing pauses. In React, keep the debounced function in a `useRef` or `useMemo` so it survives re-renders.",
].join("\n");

export const R_HTML = `<!doctype html><html><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#faf6f2;color:#222"><div style="text-align:center"><div id="t" style="font-size:64px;font-weight:600">25:00</div><button id="b" style="padding:8px 22px;font-size:16px;margin-top:12px;cursor:pointer">Start</button></div><script>let s=1500,i=null;const t=document.getElementById('t'),b=document.getElementById('b');const f=()=>t.textContent=String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');b.onclick=()=>{if(i){clearInterval(i);i=null;b.textContent='Start'}else{b.textContent='Pause';i=setInterval(()=>{s=Math.max(0,s-1);f()},1000)}};</script></body></html>`;

export const R_DOC = [
  "# Project plan",
  "",
  "## Goal",
  "Ship a small, working first version and learn from real use.",
  "",
  "## Milestones",
  "1. Define scope and success criteria",
  "2. Build the core flow end to end",
  "3. Test with a few real users",
  "4. Polish and release",
  "",
  "## Risks",
  "- Scope creep",
  "- Unclear requirements",
  "",
  "> This document is placeholder content.",
].join("\n");

export interface SeedMessage {
  role: "user" | "assistant";
  text: string;
}
export interface SeedChat {
  id: string;
  title: string;
  pinned: boolean;
  projectId: string | null;
  updated: string;
  model: string;
  ctxExtra?: number;
  messages: SeedMessage[];
}
export interface SeedProvider {
  id: string;
  type: string;
  name: string;
  baseUrl: string;
  key: string;
  enabled: boolean;
  status: "connected" | "error" | "untested";
  models: string[];
}
export interface SeedMemory {
  id: string;
  text: string;
  src: string;
  date: string;
}
export interface SeedProjectFile {
  name: string;
  size: string;
}
export interface SeedProject {
  id: string;
  name: string;
  desc: string;
  instructions: string;
  files: SeedProjectFile[];
  updated: string;
}
export interface SeedReplyArtifact {
  type: "html" | "doc";
  title: string;
  content: string;
}
export interface SeedReply {
  text: string;
  artifact?: SeedReplyArtifact;
}

function mk(user: string, assistant: string): SeedMessage[] {
  return [
    { role: "user", text: user },
    { role: "assistant", text: assistant },
  ];
}

export const SEED_NOW: number = Date.parse("2026-10-08T12:00:00");

export const SEED_USER = { name: "Abu", initials: "AB", plan: "BYOK · Free" };

export const SEED_PROVIDERS: SeedProvider[] = [
  { id: "p1", type: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", key: "sk-live-1234a3f9", enabled: true, status: "connected", models: ["gpt-4.1", "gpt-4.1-mini"] },
  { id: "p2", type: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", key: "sk-ant-9999b7c2", enabled: true, status: "connected", models: ["claude-sonnet", "claude-haiku"] },
  { id: "p3", type: "ollama", name: "Ollama (local)", baseUrl: "http://localhost:11434/v1", key: "", enabled: false, status: "untested", models: ["llama3.2", "qwen2.5-coder"] },
];

export const SEED_MODEL_META: Record<string, { ctx: number; tags: string[] }> = {
  "gpt-4.1": { ctx: 128000, tags: ["vision"] },
  "gpt-4.1-mini": { ctx: 128000, tags: [] },
  "gpt-4o": { ctx: 128000, tags: ["vision"] },
  "o4-mini": { ctx: 200000, tags: ["reasoning"] },
  "claude-sonnet": { ctx: 200000, tags: ["vision", "reasoning"] },
  "claude-haiku": { ctx: 200000, tags: ["vision"] },
  "claude-opus": { ctx: 200000, tags: ["vision", "reasoning"] },
  "llama3.2": { ctx: 128000, tags: [] },
  "qwen2.5-coder": { ctx: 32000, tags: [] },
  mistral: { ctx: 32000, tags: [] },
  "gemini-2.5-pro": { ctx: 1000000, tags: ["vision", "reasoning"] },
  "gemini-2.5-flash": { ctx: 1000000, tags: ["vision"] },
  "gemini-2.0-flash": { ctx: 1000000, tags: ["vision"] },
  "deepseek-chat": { ctx: 64000, tags: [] },
  "openrouter/auto": { ctx: 128000, tags: [] },
  "meta-llama/llama-3.3-70b": { ctx: 128000, tags: [] },
};

export const SEED_DEFAULT_MODEL = "p2:claude-sonnet";

export const SEED_MEMORIES: SeedMemory[] = [
  { id: "m1", text: "Prefers short, direct answers", src: "manual", date: "2026-09-30" },
  { id: "m2", text: "Works mostly with TypeScript and React", src: "Debounce in React", date: "2026-10-01" },
  { id: "m3", text: "Lives in Nigeria (WAT timezone)", src: "manual", date: "2026-10-02" },
  { id: "m4", text: "Likes dark mode", src: "manual", date: "2026-10-03" },
  { id: "m5", text: "Currently building a desktop chat app", src: "Plan a landing page", date: "2026-10-05" },
];

export const SEED_PROJECTS: SeedProject[] = [
  { id: "pr1", name: "Portfolio site", desc: "Personal developer portfolio", instructions: "Answer as a senior frontend engineer.", files: [{ name: "brief.pdf", size: "210 KB" }], updated: "2026-10-06" },
  { id: "pr2", name: "Client dashboard", desc: "Analytics dashboard for a freelance client", instructions: "Keep answers concise and use TypeScript examples.", files: [{ name: "requirements.md", size: "12 KB" }, { name: "wireframes.pdf", size: "1.2 MB" }], updated: "2026-10-03" },
  { id: "pr3", name: "Study notes", desc: "Notes and questions while learning new tools", instructions: "Explain step by step with small examples.", files: [], updated: "2026-09-28" },
];

export const SEED_CHATS: SeedChat[] = [
  { id: "c1", title: "Debounce in React", pinned: true, projectId: null, updated: "2026-10-08T09:10:00", model: "p2:claude-sonnet", ctxExtra: 75000, messages: mk("How do I debounce a search input in React?", R_CODE) },
  { id: "c2", title: "API design notes", pinned: true, projectId: "pr2", updated: "2026-10-05T10:00:00", model: "p2:claude-sonnet", messages: mk("Give me tradeoffs for REST vs GraphQL.", R_LIST) },
  { id: "c3", title: "Draft email to client", pinned: false, projectId: "pr2", updated: "2026-10-08T08:00:00", model: "p1:gpt-4.1", messages: mk("Draft a short email asking a client for feedback.", "Subject: Quick feedback request\n\nHi there,\n\nCould you take a few minutes to review the latest build and share your thoughts by Friday? Short notes are perfect.\n\nThanks!") },
  { id: "c4", title: "Tailwind vs plain CSS", pinned: false, projectId: null, updated: "2026-10-07T16:20:00", model: "p2:claude-sonnet", messages: mk("Tailwind or plain CSS for a small site?", R_SHORT) },
  { id: "c5", title: "Rust ownership explained", pinned: false, projectId: "pr3", updated: "2026-10-07T11:00:00", model: "p2:claude-haiku", messages: mk("Explain Rust ownership simply.", "Each value has exactly one **owner**. When the owner goes out of scope, the value is dropped. You can *borrow* a value with `&` without taking ownership.") },
  { id: "c6", title: "Plan a landing page", pinned: false, projectId: "pr1", updated: "2026-10-05T14:00:00", model: "p2:claude-sonnet", messages: mk("Plan a landing page for my portfolio.", R_LIST) },
  { id: "c7", title: "Fix CORS error", pinned: false, projectId: null, updated: "2026-10-04T09:00:00", model: "p1:gpt-4.1", messages: mk("Why do I get a CORS error on fetch?", R_SHORT) },
  { id: "c8", title: "SQL joins cheat sheet", pinned: false, projectId: null, updated: "2026-10-02T18:00:00", model: "p1:gpt-4.1-mini", messages: mk("Summarize SQL joins.", R_LIST) },
  { id: "c9", title: "Docker compose basics", pinned: false, projectId: null, updated: "2026-09-26T12:00:00", model: "p2:claude-sonnet", messages: mk("How do I write a docker-compose file?", R_CODE) },
  { id: "c10", title: "Regex for emails", pinned: false, projectId: null, updated: "2026-09-18T12:00:00", model: "p1:gpt-4.1", messages: mk("Regex to validate an email?", R_SHORT) },
  { id: "c11", title: "Learn Git rebase", pinned: false, projectId: "pr3", updated: "2026-09-09T12:00:00", model: "p2:claude-sonnet", messages: mk("When should I rebase instead of merge?", R_SHORT) },
];

export const SEED_SUGGESTIONS: string[] = ["Explain a concept", "Draft an email", "Debug my code", "Plan a project"];

export const SEED_REPLIES: SeedReply[] = [
  { text: R_SHORT },
  { text: R_LIST },
  { text: R_CODE },
  { text: "Here's a simple Pomodoro timer. I put it in the panel on the right; switch between **Preview** and **Code**.", artifact: { type: "html", title: "Pomodoro timer", content: R_HTML } },
  { text: "I drafted a short project plan as a document. Open it in the panel to read or copy the source.", artifact: { type: "doc", title: "Project plan", content: R_DOC } },
];

export const SEED_CMDS: ReadonlyArray<readonly [string, string]> = [
  ["new", "New chat"],
  ["compact", "Compact context"],
  ["model", "Switch model"],
  ["clear", "Clear chat"],
  ["memory", "Open memory"],
  ["settings", "Open settings"],
];

export const SEED_PAGES: ReadonlyArray<readonly [string, string, string]> = [
  ["general", "General", "settings"],
  ["appearance", "Appearance", "palette"],
  ["providers", "Providers", "plug"],
  ["models", "Models", "cpu"],
  ["memory", "Memory", "brain"],
  ["data", "Data", "database"],
  ["shortcuts", "Shortcuts", "keyboard"],
  ["about", "About", "info"],
];

export const SEED_ACCENTS: ReadonlyArray<readonly [string, string]> = [
  ["Clay", "#c96442"],
  ["Blue", "#0067c0"],
  ["Green", "#0f7b0f"],
  ["Purple", "#7a42d6"],
  ["Pink", "#c239b3"],
  ["Graphite", "#5c5c5c"],
];

export const SEED_SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ["Ctrl+K", "Open command palette"],
  ["Ctrl+N", "New chat"],
  ["Ctrl+,", "Open Settings"],
  ["Ctrl+B", "Toggle sidebar"],
  ["Ctrl+Shift+A", "Toggle artifact panel"],
  ["Ctrl+Shift+C", "Compact conversation"],
  ["Esc", "Close overlay, else stop streaming"],
  ["F11", "Toggle maximize icon"],
];

/** Thread status indicator states (plan 2026-10-09, Task 029). */
export type ThreadStatus = "working" | "done" | "not-viewed" | "idle";

export interface ThreadStatusInfo {
  status: ThreadStatus;
  updatedAt: number;
  lastReadAt: number;
  running: boolean;
}

export function threadStatus(info: ThreadStatusInfo): ThreadStatus {
  if (info.running) return "working";
  if (info.updatedAt > info.lastReadAt) return info.lastReadAt === 0 ? "not-viewed" : "done";
  return "idle";
}

/** Pure date-grouping port of prototype `groupChats` (index.html:370). */
export function groupChats(chats: SeedChat[], now: number = SEED_NOW): Array<[string, SeedChat[]]> {
  const t0 = new Date(now);
  t0.setHours(0, 0, 0, 0);
  const start = t0.getTime();
  const groups: Record<string, SeedChat[]> = {
    Pinned: [],
    Today: [],
    Yesterday: [],
    "Previous 7 days": [],
    Older: [],
  };
  [...chats]
    .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))
    .forEach((c) => {
      const t = Date.parse(c.updated);
      const bucket = c.pinned
        ? "Pinned"
        : t >= start
          ? "Today"
          : t >= start - DAY
            ? "Yesterday"
            : t >= start - 7 * DAY
              ? "Previous 7 days"
              : "Older";
      groups[bucket].push(c);
    });
  return Object.entries(groups).filter(([, v]) => v.length > 0);
}

/** Deterministic fake-reply picker mirroring prototype `pickReply` (index.html:466). */
export function pickMockReply(text: string, index: number): SeedReply {
  if (/\/code|\bcode\b/i.test(text)) return SEED_REPLIES[2];
  if (/\bartifact\b|\bbuild\b/i.test(text)) {
    return /\b(doc|plan)\b/i.test(text) ? SEED_REPLIES[4] : SEED_REPLIES[3];
  }
  return SEED_REPLIES[index % SEED_REPLIES.length];
}

/**
 * Task 031 T5 — seed transcript for one chat. A copy of the seed messages,
 * or the honest empty when the id is unknown (blockers B18 rule: never fake
 * rows for ids the seed does not own).
 */
export function mockTranscript(chatId: string): SeedMessage[] {
  const chat = SEED_CHATS.find((c) => c.id === chatId);
  if (chat === undefined) return [];
  return chat.messages.map((m) => ({ role: m.role, text: m.text }));
}

/**
 * Task 031 T5 — the default mock model (`SEED_DEFAULT_MODEL`, "p2:claude-sonnet")
 * in the structural shape the thread store's `selectModel` accepts. Restated
 * here (not imported from the catalogue) so the mock seed never depends on
 * real modules — the dependency points mock → nothing.
 */
export interface MockModelSelection {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
  reasoning: boolean;
  toolCall: boolean;
}

export function defaultMockModel(): MockModelSelection {
  const [provider, ...rest] = SEED_DEFAULT_MODEL.split(":");
  const id = rest.join(":");
  const meta: { ctx: number; tags: string[] } | undefined = (
    SEED_MODEL_META as Record<string, { ctx: number; tags: string[] } | undefined>
  )[id];
  return {
    provider,
    id,
    name: id,
    contextWindow: meta?.ctx ?? 128_000,
    maxOutput: 8192,
    reasoning: meta?.tags.includes("reasoning") ?? false,
    toolCall: true,
  };
}
