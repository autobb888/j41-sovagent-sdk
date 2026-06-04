/**
 * Model-less scan orchestrator — VENDORED slim variant of @sovguard/engine's
 * scanner/index.ts scan().
 *
 * Runs ONLY the dependency-free detection layers (regex + indirect + perplexity)
 * so it can run in-process in the j41 SDK / job-agent with no native modules
 * (no onnxruntime-node, no better-sqlite3). The ONNX classifier + semantic
 * layers from @sovguard/engine are intentionally absent — results carry
 * `degraded: true` to make that explicit. Produces the same ScanResult shape so
 * the vendored context.ts behaves identically to the full engine on these layers.
 */

import type { Classification, LayerResult, ScanResult, SovGuardConfig } from './types.js';
import { regexScan } from './regex.js';
import { indirectInjectionScan } from './indirect.js';
import { perplexityScan } from './perplexity.js';

// Bypass-proof bound. The old 100KB cap silently truncated-and-passed: an
// attacker padded an injection past 100KB and the unscanned tail read as "safe".
// This SDK has no worker pool (it runs in-process in the job-agent), so we bound
// synchronous work at a high ceiling — but never silently truncate-and-pass:
// input above the ceiling is forced non-safe so scanContext contains it.
const HARD_MAX_INPUT = 1_000_000; // 1MB (~0.8s worst-case sync scan)

/**
 * Run one detection layer, swallowing any exception and degrading to a
 * `_layer_error`-flagged safe result. Critical: without this, a single layer
 * throwing (a future regex syntax bug, a perplexity stack overflow on
 * pathological input, a parser corner case) aborts the whole scan and the
 * dispatcher wrapper fails-OPEN — handing the attacker a bypass by crafting
 * input that crashes any one layer. Per-layer isolation preserves the
 * defense even when one layer fails.
 */
function runLayer(name: string, fn: () => LayerResult): LayerResult {
  try {
    return fn();
  } catch (e) {
    return {
      layer: name,
      score: 0,
      flags: [`${name}_layer_error`],
      details: { error: e instanceof Error ? e.message : String(e) },
    };
  }
}

export async function scan(text: string, config: SovGuardConfig = {}): Promise<ScanResult> {
  const blockThreshold = config.blockThreshold ?? 0.7;
  const suspiciousThreshold = config.suspiciousThreshold ?? 0.3;

  // Scan up to the ceiling; remember if anything was left unscanned.
  const truncated = text.length > HARD_MAX_INPUT;
  const input = truncated ? text.slice(0, HARD_MAX_INPUT) : text;

  const layers: LayerResult[] = [];
  layers.push(runLayer('regex', () => regexScan(input)));
  layers.push(runLayer('indirect', () => indirectInjectionScan(input)));
  if (config.enablePerplexity !== false) {
    layers.push(runLayer('perplexity', () => perplexityScan(input)));
  }

  // Model-less: combined score is the max across the available layers.
  let score = Math.min(layers.reduce((max, l) => Math.max(max, l.score), 0), 1.0);
  let flags = layers.flatMap(l => l.flags).filter(f => !f.endsWith('_unavailable'));

  if (truncated) {
    // The tail couldn't be scanned — never let it read as "safe". Force at least
    // "suspicious" so scanContext contains it (strip → quarantine for untrusted).
    score = Math.max(score, suspiciousThreshold);
    flags = [...flags, 'oversized_unscanned_input'];
  }

  const classification: Classification =
    score >= blockThreshold ? 'likely_injection'
      : score >= suspiciousThreshold ? 'suspicious'
        : 'safe';

  return {
    safe: classification === 'safe',
    score,
    classification,
    flags,
    layers,
    scannedAt: Date.now(),
    degraded: true,
    degradedLayers: ['classifier', 'semantic'],
  };
}
