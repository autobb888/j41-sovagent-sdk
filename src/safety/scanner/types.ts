/**
 * Scanner types — VENDORED (trimmed) from @sovguard/engine src/types.ts.
 *
 * Only the detection-layer types are copied here so the model-less scanner
 * (regex + indirect + perplexity) can run in-process inside the j41 SDK with no
 * native dependencies. Keep in sync with @sovguard/engine when those layers
 * change. See also the canary vendoring in ../canary.ts.
 */

export type Severity = 'low' | 'medium' | 'high';
export type Classification = 'safe' | 'suspicious' | 'likely_injection';

export type AttackCategory =
  | 'instruction_override'
  | 'role_play'
  | 'encoding_trick'
  | 'context_manipulation'
  | 'exfiltration'
  | 'delimiter_attack'
  | 'adversarial_suffix'
  | 'financial_manipulation'
  | 'chatml_injection'
  | 'policy_puppetry'
  | 'tool_poisoning'
  | 'goal_hijacking'
  | 'memory_poisoning'
  | 'agent_impersonation';

export interface PatternMatch {
  pattern: string;
  category: AttackCategory;
  severity: Severity;
  matched: string;
}

export interface LayerResult {
  layer: string;
  score: number;
  flags: string[];
  details?: Record<string, unknown>;
}

export interface ScanResult {
  safe: boolean;
  score: number; // 0 (safe) to 1 (dangerous)
  classification: Classification;
  flags: string[];
  layers: LayerResult[];
  scannedAt: number;
  /** True when a layer that could have run did not (here: the ML layers are
   * never present in the vendored model-less scanner). */
  degraded?: boolean;
  degradedLayers?: string[];
}

export interface SovGuardConfig {
  /** Threshold above which messages are classified as likely_injection (0-1). Default: 0.7 */
  blockThreshold?: number;
  /** Threshold above which messages are suspicious (0-1). Default: 0.3 */
  suspiciousThreshold?: number;
  /** Enable perplexity scanner. Default: true */
  enablePerplexity?: boolean;
  /** Accepted for API parity with @sovguard/engine; the vendored scanner is model-less. */
  enableClassifier?: boolean;
  /** Accepted for API parity with @sovguard/engine; the vendored scanner is model-less. */
  enableSemantic?: boolean;
  /** Custom regex patterns to add. */
  extraPatterns?: Array<{ pattern: RegExp; category: AttackCategory; severity: Severity }>;
}
