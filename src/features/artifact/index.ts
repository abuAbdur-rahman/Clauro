/**
 * Artifact feature barrel (Task 024, D112).
 *
 * Import from the feature, not the file: `../features/artifact`.
 * `frame-runtime.js` ships to the sandbox as raw text and is never
 * re-exported here — it must not enter the app bundle.
 */
export {
  useDrawerStore,
  sandboxAttr,
  artifactGate,
  SANDBOX_TOKENS,
  type DrawerEntry,
  type DrawerState,
  type EngineGate,
  type GateVerdict,
} from "./store";
export {
  prepareArtifact,
  newNonce,
  createCompileWorker,
  type PrepareInput,
  type PrepareResult,
} from "./prepare";
export {
  compileBlocks,
  extractJsxBlocks,
  COMPILE_TIMEOUT_MS,
  COMPILED_MAX_BYTES,
  type CompileOptions,
  type CompileOutcome,
  type WorkerLike,
} from "./compile";
export { transformJsx, describeThrown, type Transform } from "./compile.transform";
export {
  hostSide,
  bootChannel,
  wireInbound,
  validHandshake,
  isAllowed,
  send,
  FRAME_TO_HOST,
  HOST_TO_FRAME,
  type FrameMessage,
  type HostMessage,
  type HostLog,
  type HostSide,
  type HostSideOptions,
} from "./channel";
export { buildEnvelope, type EnvelopeInput } from "./envelope";
export { sanitizeSvg, type SanitizeOutcome } from "./sanitize";
export { wrapModule } from "./wrap";
