/**
 * Catalogue feature barrel (Task 024, D112).
 *
 * Model catalogue bridge, limit resolution, and per-thread state.
 * Import from the feature, not the file: `../features/catalogue`.
 */
export {
  parseCataloguePayload,
  shortError,
  refreshCatalogue,
  webviewStatus,
  keyringStore,
  keyringRetrieve,
  keyringAvailable,
  CatalogueModelSchema,
  type CatalogueModel,
  type CataloguePayload,
  type WebviewStatus,
} from "./catalogue";
export {
  resolveLimits,
  switchWarnings,
  hashSystemPrompt,
  ModelRefSchema,
  ModelLimitsSchema,
  LimitSourcesSchema,
  type ModelRef,
  type ModelLimits,
  type LimitSource,
  type LimitSources,
  type UnknownModel,
  type ResolvedLimits,
  type ModelWithLimits,
} from "./models";
export { useThreadStore, type Effort, type ThreadState } from "./thread";
