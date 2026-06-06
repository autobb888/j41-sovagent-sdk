/**
 * Public entry for daemon-less code-exec content scanning, vendored from
 * @sovguard/engine. Model-less (regex + code-exec), no native deps.
 *
 *   import { scanContent } from '@junction41/sovagent-sdk/dist/safety/content.js'
 */

export { scanContent } from './scanner/content.js';
export type { ContentScanResult, ScanContentOptions } from './scanner/content.js';
export type { ExecContext, CodeExecAction } from './scanner/codeexec.js';
