/**
 * Layer 2: Perplexity Scanner
 * Detects GCG adversarial suffixes via character-level entropy and distribution analysis.
 */

import type { LayerResult } from './types.js';

/**
 * Calculate Shannon entropy of a string at the character level.
 */
function charEntropy(text: string): number {
  if (text.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const c of text) {
    freq.set(c, (freq.get(c) || 0) + 1);
  }
  let entropy = 0;
  const len = text.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Check for unusual character distributions that indicate adversarial input.
 */
function analyzeDistribution(text: string): {
  specialCharRatio: number;
  nonAsciiRatio: number;
  digitRatio: number;
  uppercaseRatio: number;
  consecutiveSpecial: number;
  mixedScripts: boolean;
} {
  let special = 0, nonAscii = 0, digits = 0, uppercase = 0;
  let maxConsecutiveSpecial = 0, currentConsecutive = 0;
  const scripts = new Set<string>();

  for (const c of text) {
    const code = c.codePointAt(0) ?? 0;
    if (code > 127) {
      nonAscii++;
      // Detect script ranges
      if (code >= 0x0400 && code <= 0x04FF) scripts.add('cyrillic');
      else if (code >= 0x0370 && code <= 0x03FF) scripts.add('greek');
      else if (code >= 0x4E00 && code <= 0x9FFF) scripts.add('cjk');
      else if (code >= 0x0600 && code <= 0x06FF) scripts.add('arabic');
      else scripts.add('other');
    }
    const cc = c.charCodeAt(0);
    if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122)) scripts.add('latin');
    const isAlnum = (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122);
    const isCommon = isAlnum || cc === 32 || cc === 9 || cc === 10 || cc === 13
      || cc === 46 || cc === 44 || cc === 33 || cc === 63 || cc === 59 || cc === 58
      || cc === 39 || cc === 34 || cc === 40 || cc === 41 || cc === 45;
    if (!isCommon) {
      special++;
      currentConsecutive++;
      maxConsecutiveSpecial = Math.max(maxConsecutiveSpecial, currentConsecutive);
    } else {
      currentConsecutive = 0;
    }
    if (cc >= 48 && cc <= 57) digits++;
    if (cc >= 65 && cc <= 90) uppercase++;
  }

  const len = Math.max(text.length, 1);
  return {
    specialCharRatio: special / len,
    nonAsciiRatio: nonAscii / len,
    digitRatio: digits / len,
    uppercaseRatio: uppercase / len,
    consecutiveSpecial: maxConsecutiveSpecial,
    mixedScripts: scripts.size > 2,
  };
}

/**
 * Detect segments of gibberish mixed with normal text (GCG pattern).
 */
function detectGibberishSegments(text: string): { found: boolean; segments: string[] } {
  // Split into words and check for long "words" with high entropy
  const words = text.split(/\s+/);
  const gibberish: string[] = [];

  for (const word of words) {
    if (word.length >= 15) {
      const entropy = charEntropy(word);
      // Normal English words have entropy ~3.5-4.2, gibberish is higher
      if (entropy > 4.5) {
        gibberish.push(word);
      }
    }
  }

  return { found: gibberish.length > 0, segments: gibberish };
}

/**
 * Run perplexity-based scan on text.
 */
export function perplexityScan(text: string): LayerResult {
  const flags: string[] = [];
  let score = 0;

  // Skip short messages
  if (text.length < 20) {
    return { layer: 'perplexity', score: 0, flags: [] };
  }

  const entropy = charEntropy(text);
  const dist = analyzeDistribution(text);
  const gibberish = detectGibberishSegments(text);

  // High overall entropy
  if (entropy > 5.0) {
    score += 0.3;
    flags.push('high_entropy');
  }

  // High special character ratio
  if (dist.specialCharRatio > 0.3) {
    score += 0.25;
    flags.push('high_special_chars');
  }

  // Long consecutive special characters
  if (dist.consecutiveSpecial > 10) {
    score += 0.3;
    flags.push('consecutive_special_chars');
  }

  // Mixed scripts (homoglyph attacks)
  if (dist.mixedScripts) {
    score += 0.2;
    flags.push('mixed_scripts');
  }

  // Gibberish segments (GCG pattern)
  if (gibberish.found) {
    score += 0.4;
    flags.push(`gibberish_segments:${gibberish.segments.length}`);
  }

  // Unusual digit ratio (encoded payloads)
  if (dist.digitRatio > 0.4) {
    score += 0.15;
    flags.push('high_digit_ratio');
  }

  // Token splitting: "i g n o r e a l l" — single chars separated by spaces/delimiters
  if (detectTokenSplitting(text)) {
    score += 0.3;
    flags.push('token_splitting');
  }

  // Padding attack: 20+ repeated chars comprising >15% of text
  if (detectPaddingAttack(text)) {
    score += 0.25;
    flags.push('padding_attack');
  }

  // Adversarial suffix heuristic: detects GCG-style gibberish appended to
  // normal-looking text. Key signals: concatenated words (camelCase in
  // non-code context), orphan brackets/parens, and sentence fragments.
  if (detectAdversarialSuffix(text)) {
    score += 0.35;
    flags.push('adversarial_suffix_pattern');
  }

  // Invisible character density
  const invisDensity = invisibleCharDensity(text);
  if (invisDensity > 0.03) {
    score += 0.3;
    flags.push('invisible_char_high_density');
  } else if (invisDensity > 0.01) {
    score += 0.15;
    flags.push('invisible_char_density');
  }

  // Many-shot jailbreak: detect anomalously long messages with repeated Q&A patterns
  const manyShot = detectManyShotJailbreak(text);
  if (manyShot.found) {
    score += 0.4;
    flags.push(`many_shot_jailbreak:${manyShot.exampleCount}_examples`);
  }

  // Deceptive Delight: benign wrapper with injection buried in the middle
  if (detectDeceptiveDelight(text)) {
    score += 0.35;
    flags.push('deceptive_delight_structure');
  }

  return {
    layer: 'perplexity',
    score: Math.min(score, 1.0),
    flags,
    details: {
      entropy,
      distribution: dist,
      gibberishSegments: gibberish.segments.length,
    },
  };
}

/**
 * Detect GCG-style adversarial suffixes.
 * These are gibberish fragments appended to normal requests, designed to
 * slip past entropy checks by using real-ish English words mashed together.
 *
 * Signals:
 *  - camelCase word concatenation outside code context (e.g. "similarlyNow")
 *  - orphan/mismatched brackets in non-code text (e.g. "](Me")
 *  - unusual punctuation clusters (e.g. ".--")
 */
function detectAdversarialSuffix(text: string): boolean {
  // Skip text that looks like code — code naturally has camelCase and brackets
  const codeIndicators = /(?:function\s|const\s|let\s|var\s|=>|import\s|class\s|def\s|return\s|```)/;
  if (codeIndicators.test(text)) return false;

  let signals = 0;

  // 1. camelCase concatenated words: lowercase letter immediately followed by uppercase
  //    in a non-code context. Count occurrences — 2+ is suspicious.
  const camelCaseMatches = text.match(/[a-z][A-Z]/g);
  if (camelCaseMatches && camelCaseMatches.length >= 2) {
    signals++;
  }

  // 2. Orphan/mismatched brackets or parens not typical of prose.
  //    Look for ] followed by ( or [ without matching pair, etc.
  const orphanBrackets = /\]\s*\(|\)\s*\[|\}\s*\(|\)\s*\{/;
  if (orphanBrackets.test(text)) {
    signals++;
  }

  // 3. Unusual punctuation clusters: two or more punctuation marks in a row
  //    excluding common combos like "...", "?!", "--" (em dash).
  //    Look for uncommon sequences like ".--", ";)", ".-", etc.
  const punctClusters = text.match(/[.!?;,]\s*[-\[\](){}]/g);
  if (punctClusters && punctClusters.length >= 2) {
    signals++;
  }

  // 4. Misspelled/mangled words: words ending in unusual letter combos
  //    that look like corrupted English (e.g. "oppositeley", "instructionss")
  const words = text.split(/\s+/);
  let mangledCount = 0;
  for (const word of words) {
    const clean = word.replace(/[^a-zA-Z]/g, '');
    if (clean.length >= 6) {
      // Double-suffix patterns: -eley, -ley at end after already having -te/-se
      if (/[aeiou]le?y$/i.test(clean) && /t[eioa]le?y$/i.test(clean)) {
        mangledCount++;
      }
    }
  }
  if (mangledCount >= 1) signals++;

  // Need 2+ signals to flag — prevents false positives from code or casual text
  return signals >= 2;
}

/**
 * Detect token splitting: single characters separated by delimiters.
 * e.g. "i g n o r e a l l" or "i.g.n.o.r.e"
 */
function detectTokenSplitting(text: string): boolean {
  // Look for runs of 6+ single alphanumeric chars separated by a consistent delimiter
  const pattern = /(?:^|[\s.,;|/\\-])([a-zA-Z])(?:[\s.,;|/\\-])([a-zA-Z])(?:[\s.,;|/\\-])([a-zA-Z])(?:[\s.,;|/\\-])([a-zA-Z])(?:[\s.,;|/\\-])([a-zA-Z])(?:[\s.,;|/\\-])([a-zA-Z])/;
  return pattern.test(text);
}

/**
 * Detect padding attacks: 20+ of the same character comprising >15% of text.
 */
function detectPaddingAttack(text: string): boolean {
  // Find runs of 20+ identical characters
  const padPattern = /(.)\1{19,}/g;
  let totalPadding = 0;
  let match;
  while ((match = padPattern.exec(text)) !== null) {
    totalPadding += match[0].length;
  }
  return totalPadding > 0 && totalPadding / text.length > 0.15;
}

/**
 * Detect many-shot jailbreak: long messages with repeated Q&A example patterns.
 * Many-shot uses dozens of fake Q&A pairs to shift model behavior.
 */
function detectManyShotJailbreak(text: string): { found: boolean; exampleCount: number } {
  if (text.length < 200) return { found: false, exampleCount: 0 };
  // Count Q&A style patterns
  const qaPatterns = text.match(/(?:^|\n)\s*(?:Q|Question|User|Human|Input)\s*[:\-]\s*.+\n\s*(?:A|Answer|Assistant|AI|Output|Response)\s*[:\-]/gim);
  const count = qaPatterns?.length ?? 0;
  // 5+ Q&A pairs in a single message is suspicious
  return { found: count >= 5, exampleCount: count };
}

/**
 * Calculate density of zero-width / invisible characters in the original text.
 */
function invisibleCharDensity(text: string): number {
  if (text.length === 0) return 0;
  const invisible = text.match(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\u00AD]/g);
  return invisible ? invisible.length / text.length : 0;
}

/**
 * Detect Deceptive Delight structural pattern: messages where the first ~30%
 * and last ~30% are benign prose, but the middle ~40% contains injection
 * keywords. This catches the "sandwich" attack where malicious instructions
 * are wrapped in harmless-looking text to evade simple keyword scanning
 * that weights the start/end of messages more heavily.
 *
 * The detection works by splitting the message into thirds and checking
 * whether injection-related keywords are concentrated in the middle segment
 * while the outer segments appear benign.
 */
function detectDeceptiveDelight(text: string): boolean {
  // Need a reasonably long message for the sandwich pattern to work
  if (text.length < 120) return false;

  const len = text.length;
  const boundary1 = Math.floor(len * 0.3);
  const boundary2 = Math.floor(len * 0.7);

  const head = text.slice(0, boundary1);
  const middle = text.slice(boundary1, boundary2);
  const tail = text.slice(boundary2);

  // Injection keywords to look for in the middle segment
  const injectionPattern = /\b(ignore|disregard|forget|override|bypass|reveal|show\s+me|dump|system\s*prompt|previous\s+instructions?|new\s+instructions?|jailbreak|pretend|act\s+as|you\s+are\s+now|admin\s+override|developer\s+mode|repeat\s+your|output\s+your)\b/gi;

  const middleMatches = middle.match(injectionPattern) || [];
  const headMatches = head.match(injectionPattern) || [];
  const tailMatches = tail.match(injectionPattern) || [];

  // The middle must have injection keywords
  if (middleMatches.length === 0) return false;

  // The outer segments should be mostly clean (0-1 matches combined)
  const outerMatches = headMatches.length + tailMatches.length;
  if (outerMatches > 1) return false;

  // The middle should have significantly more injection signal than outer
  // At least 2 injection keywords concentrated in the middle
  if (middleMatches.length < 2) return false;

  // Additional check: outer segments should look like normal prose
  // (contain common English words, proper sentence structure)
  const prosePattern = /\b(the|a|an|is|are|was|were|have|has|do|does|will|would|can|could|please|thank|help|about|with|this|that|how|what|why|when|where|who)\b/gi;
  const headProse = (head.match(prosePattern) || []).length;
  const tailProse = (tail.match(prosePattern) || []).length;

  // Both outer segments should contain some normal English
  return headProse >= 2 && tailProse >= 1;
}
