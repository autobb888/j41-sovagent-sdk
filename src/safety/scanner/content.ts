/**
 * Daemon-less code-exec content scan, vendored from @sovguard/engine.
 *
 * Mirrors the main repos' file-content scanText: the regex injection layer +
 * code-exec detection, folded by execution context into an allow/warn/block
 * decision. scanContext() (source-trust / prompt-injection) is separate.
 */

import { regexScan } from './regex.js';
import { detectCodeExec, decideCodeExec, isDocPath, type ExecContext, type CodeExecAction } from './codeexec.js';

const HARD_MAX_INPUT = 1_000_000; // 1MB, matches scan.ts

export interface ContentScanResult {
  safe: boolean;
  score: number;
  flags: string[];
  action: CodeExecAction;
  warnings: string[];
  category: string | null;
  reason: string | null;
}

export interface ScanContentOptions {
  /** Execution-context hint for code-exec severity gating. */
  context?: ExecContext;
  /** MIME of the content (drives doc-context detection when no path). */
  mimeType?: string;
}

const NETWORK_EXFIL_RE = /:(?:curl_exfil|wget_exfil)$/;

export function scanContent(text: string, opts: ScanContentOptions = {}): ContentScanResult {
  const truncated = text.length > HARD_MAX_INPUT ? text.slice(0, HARD_MAX_INPUT) : text;

  const injection = regexScan(truncated);
  const allFlags = injection.flags.map((f) => `content:${f}`);

  const codeDecision = decideCodeExec(detectCodeExec(truncated), opts.context, opts.mimeType);

  // README-FP reconciliation: in doc context, legacy curl/wget exfil flags are
  // illustrative — downgrade to warnings (mirrors the main content scanner).
  const doc = isDocPath(opts.context?.path, opts.mimeType);
  const injectionFlags: string[] = [];
  const downgradedWarnings: string[] = [];
  for (const f of new Set(allFlags)) {
    if (doc && NETWORK_EXFIL_RE.test(f)) downgradedWarnings.push(f);
    else injectionFlags.push(f);
  }

  const finalFlags = [...new Set([...injectionFlags, ...codeDecision.flags])];
  const finalWarnings = [...new Set([...downgradedWarnings, ...codeDecision.warnings])];
  const safe = finalFlags.length === 0;
  const action: CodeExecAction = finalFlags.length > 0 ? 'block' : finalWarnings.length > 0 ? 'warn' : 'allow';
  const baseScore = Math.max(injectionFlags.length > 0 ? injection.score : 0, codeDecision.score);
  const score = action === 'warn' && baseScore === 0 ? 0.15 : baseScore;

  return { safe, score, flags: finalFlags, action, warnings: finalWarnings, category: codeDecision.category, reason: codeDecision.reason };
}
