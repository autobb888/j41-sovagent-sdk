/**
 * Indirect Prompt Injection Scanner
 *
 * Detects instruction-like content hidden in text that's supposed to be data
 * (RAG documents, tool outputs, emails, web pages, database records).
 * Unlike direct injection where the user sends malicious input, indirect
 * injection embeds instructions in DATA the LLM processes.
 */

import type { LayerResult } from './types.js';

// ── Heuristic 1: Instruction Boundary Markers ─────────────────────

const BOUNDARY_MARKERS: RegExp[] = [
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<<SYS>>/i,
  /<\|im_start\|>/i,
  /<\|endoftext\|>/i,
  /###\s*Instruction:/i,
  /###\s*Human:/i,
  /###\s*Assistant:/i,
  /\bUSER:/,
  /\bSYSTEM:/,
];

// ── Heuristic 2: Imperative Instruction Phrases ───────────────────

const IMPERATIVE_PHRASES: RegExp[] = [
  /\byou must\b/i,
  /\byou should now\b/i,
  /\byour new task is\b/i,
  /\bfrom now on\b/i,
  /\boverride\s+(?:all|previous|safety|instructions?|rules?|prompts?|restrictions?|guidelines?)\b/i,
  /\bdisregard previous\b/i,
  /\bact as\s+(?:an?\s+)?(?:different|unrestricted|new|my|another|the)\b/i,
  /\bpretend to be\b/i,
  /\brespond\s+with\s+(?:only|just|the\s+following|exactly)\b/i,
  /\boutput the following\b/i,
  /\bdo not mention\b/i,
  /\bnever reveal\b/i,
];

// ── Heuristic 3: Role Assumption Attempts ─────────────────────────

const ROLE_ASSUMPTION: RegExp[] = [
  /\byou are now\b/i,
  /\byou are (?:now |a (?:new|different|unrestricted|jailbroken))\b/i,
  /\byour role is\b/i,
  /\bas an AI\b/i,
  /\bas my assistant\b/i,
];

// ── Heuristic 4: Hidden Instruction Separators ────────────────────
// 10+ dashes/equals/underscores followed by instruction-like text

const SEPARATOR_PATTERN =
  /(?:-{10,}|={10,}|_{10,})\s*\n?\s*(?:new instructions|instructions|system prompt|ignore|override|you must|you are now|from now on)/i;

// ── Heuristic 5: Instruction Density ──────────────────────────────

const DENSITY_KEYWORDS = /\b(?:must|should|do not|don't|always|never)\b/i;

/**
 * Split text into approximate sentences.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/[.!?\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/**
 * Count regex matches in text.
 */
function countMatches(text: string, patterns: RegExp[]): number {
  let count = 0;
  for (const p of patterns) {
    // Use global search to count all matches per pattern
    const global = new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g');
    const matches = text.match(global);
    if (matches) count += matches.length;
  }
  return count;
}

/**
 * Check if any pattern matches.
 */
function hasMatch(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

/**
 * Scan text for indirect prompt injection heuristics.
 *
 * Returns a LayerResult with layer 'indirect', a combined score (capped at 1.0),
 * and flags prefixed with `indirect_injection:`.
 */
export function indirectInjectionScan(text: string): LayerResult {
  let score = 0;
  const flags: string[] = [];

  // Heuristic 1: Instruction boundary markers (0.4 per match, max 0.5)
  const boundaryCount = countMatches(text, BOUNDARY_MARKERS);
  if (boundaryCount > 0) {
    score += Math.min(0.4 * boundaryCount, 0.5);
    flags.push('indirect_injection:instruction_boundary');
  }

  // Heuristic 2: Imperative instruction phrases (0.2 per match, max 0.4)
  const imperativeCount = countMatches(text, IMPERATIVE_PHRASES);
  if (imperativeCount > 0) {
    score += Math.min(0.2 * imperativeCount, 0.4);
    flags.push('indirect_injection:imperative_instruction');
  }

  // Heuristic 3: Role assumption attempts (0.15 per match, max 0.3)
  const roleCount = countMatches(text, ROLE_ASSUMPTION);
  if (roleCount > 0) {
    score += Math.min(0.15 * roleCount, 0.3);
    flags.push('indirect_injection:role_assumption');
  }

  // Heuristic 4: Hidden instruction separators (0.25 per match, max 0.4)
  const sepGlobal = new RegExp(SEPARATOR_PATTERN.source, 'gi');
  const sepMatches = text.match(sepGlobal);
  const separatorCount = sepMatches ? sepMatches.length : 0;
  if (separatorCount > 0) {
    score += Math.min(0.25 * separatorCount, 0.4);
    flags.push('indirect_injection:hidden_separator');
  }

  // Heuristic 5: Instruction density (0.3 if density > 0.5)
  const sentences = splitSentences(text);
  if (sentences.length > 0) {
    const imperativeSentences = sentences.filter(s => DENSITY_KEYWORDS.test(s)).length;
    const density = imperativeSentences / sentences.length;
    if (density > 0.5) {
      score += 0.3;
      flags.push('indirect_injection:high_instruction_density');
    }
  }

  return {
    layer: 'indirect',
    score: Math.min(score, 1.0),
    flags,
    details: {
      boundaryCount,
      imperativeCount,
      roleCount,
      separatorCount,
      sentenceCount: sentences.length,
    },
  };
}
