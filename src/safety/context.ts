/**
 * Public entry for source-trust-aware scanning, vendored from @sovguard/engine.
 *
 * Imported by the dispatcher the same way the canary check is, e.g.
 *   require('@junction41/sovagent-sdk/dist/safety/context.js')
 *
 * Runs the model-less scanner (regex + indirect + perplexity) in-process — no
 * native deps, no network. See ./scanner/ for the vendored layers.
 */

export { scanContext } from './scanner/context.js';
export type {
  ContextScanOptions,
  ContextScanResult,
  SourceTrust,
  TaintPolicy,
  TaintAction,
  TaintNotification,
} from './scanner/context.js';
