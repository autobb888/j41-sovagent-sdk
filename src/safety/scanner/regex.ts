/**
 * Layer 1: Regex Pattern Scanner
 * Fast pattern matching against known prompt injection attacks.
 */

import type { AttackCategory, LayerResult, PatternMatch, Severity } from './types.js';

interface PatternDef {
  pattern: RegExp;
  category: AttackCategory;
  severity: Severity;
  label: string;
}

/**
 * Strip zero-width and control characters, collapse whitespace.
 */
/**
 * Normalize by stripping zero-width/control chars entirely (catches mid-word insertion).
 */
export function normalizeStrip(text: string): string {
  return text
    // Zero-width chars, control chars, soft hyphens, BOM
    .replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\u00AD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    // Variation selectors (U+FE00-FE0F) — can encode hidden data
    .replace(/[\uFE00-\uFE0F]/g, '')
    // Unicode tag characters (U+E0001-E007F) — invisible ASCII in Unicode plane 14
    .replace(/[\u{E0001}-\u{E007F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize by replacing zero-width/control chars with spaces (catches word-separator usage).
 */
export function normalizeSpace(text: string): string {
  return text
    .replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\u00AD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/[\uFE00-\uFE0F]/g, ' ')
    .replace(/[\u{E0001}-\u{E007F}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize full-width Latin characters (U+FF01-FF5E) to ASCII.
 * Catches attacks written with ｉｇｎｏｒｅ instead of ignore.
 */
export function normalizeFullWidth(text: string): string {
  return text.replace(/[\uFF01-\uFF5E]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

/**
 * Normalize common homoglyphs (Cyrillic/Greek lookalikes) to Latin.
 * Catches attacks using Cyrillic а/о/с/р/е etc.
 */
export function normalizeHomoglyphs(text: string): string {
  const map: Record<string, string> = {
    '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c',
    '\u0443': 'y', '\u0445': 'x', '\u0456': 'i', '\u0458': 'j', '\u04BB': 'h',
    '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041A': 'K', '\u041C': 'M',
    '\u041D': 'H', '\u041E': 'O', '\u0420': 'P', '\u0421': 'C', '\u0422': 'T',
    '\u0425': 'X', '\u04AE': 'Y',
    // Greek
    '\u03B1': 'a', '\u03BF': 'o', '\u03C1': 'p', '\u03B5': 'e',
    '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u039A': 'K', '\u039C': 'M',
    '\u039D': 'N', '\u039F': 'O', '\u03A1': 'P', '\u03A4': 'T', '\u03A7': 'X',
    // Additional homoglyphs for broader coverage
    '\u043F': 'n', // Cyrillic п → n (visual lookalike)
    '\u03C5': 'u', // Greek υ → u
    '\u03B9': 'i', // Greek ι → i
    '\u0457': 'i', // Cyrillic ї → i
    '\u04CF': 'l', // Cyrillic ӏ → l
    '\u0432': 'b', // Cyrillic в → b (visual)
    '\u043D': 'n', // Cyrillic н → n (fallback)
  };
  return text.replace(/[\u0391-\u03A9\u03B1-\u03C9\u0410-\u044F\u0456-\u0458\u04AE\u04BB\u04CF]/g,
    (ch) => map[ch] || ch);
}

/**
 * Normalize TokenBreak attacks: single-character prefix insertion to evade tokenizer classification.
 * For each word 5+ chars, tries removing the first character; if the result starts with a known
 * attack-relevant stem, uses the stripped version.
 * Example: "hignore all bprevious finstructions" → "ignore all previous instructions"
 */
export function normalizeTokenBreak(text: string): string {
  const ATTACK_STEMS = [
    'ignore', 'instruct', 'forget', 'override', 'system', 'prompt',
    'disregard', 'reveal', 'pretend', 'jailbreak', 'bypass', 'restrict',
    'filter', 'policy', 'safety', 'guardrail', 'uncensor', 'previous',
    'command', 'execute', 'admin', 'overrid', 'unlock', 'unrestrict', 'prior',
    'censor', 'delete', 'exfiltrat', 'inject', 'manipulat', 'extract',
    'abandon', 'hijack', 'exploit', 'elevat', 'privilege', 'comply',
    'obey', 'surrender', 'config', 'secret', 'credential', 'password',
  ];
  return text.replace(/\b[a-zA-Z]{5,}\b/g, (word) => {
    const stripped = word.slice(1).toLowerCase();
    for (const stem of ATTACK_STEMS) {
      if (stripped.startsWith(stem)) {
        // Preserve the case style: if original started uppercase, capitalize the replacement
        const replacement = word.slice(1);
        return replacement;
      }
    }
    return word;
  });
}

/**
 * Decode URL-encoded payloads: %69%67%6e%6f%72%65 → "ignore"
 */
export function decodeUrlEncoding(text: string): string {
  if (!/%[0-9a-fA-F]{2}/.test(text)) return text;
  try { return decodeURIComponent(text); } catch { return text; }
}

const PATTERNS: PatternDef[] = [
  // ── Instruction Overrides ──────────────────────────────────
  { pattern: /ignore\s+(all\s+|your\s+|my\s+|any\s+|the\s+)?(previous|prior)\s+(instructions?|prompts?|rules?|context)/i, category: 'instruction_override', severity: 'high', label: 'ignore_previous' },
  { pattern: /disregard\s+(all\s+|your\s+|my\s+|any\s+|the\s+)?(prior|previous|above|earlier)\s+(instructions?|prompts?|rules?)/i, category: 'instruction_override', severity: 'high', label: 'disregard_previous' },
  { pattern: /forget\s+(everything|all)\s+(you('ve)?\s+been\s+told|instructions?|above)/i, category: 'instruction_override', severity: 'high', label: 'forget_instructions' },
  { pattern: /new\s+instructions?\s*:/i, category: 'instruction_override', severity: 'high', label: 'new_instructions' },
  { pattern: /override\s+(mode|instructions?|system|previous|all)/i, category: 'instruction_override', severity: 'high', label: 'override_mode' },
  { pattern: /you\s+are\s+now\s+(a|an)\s+/i, category: 'instruction_override', severity: 'medium', label: 'you_are_now' },
  { pattern: /from\s+now\s+on\s*,?\s*(you|your|we|i\s+want)/i, category: 'instruction_override', severity: 'medium', label: 'from_now_on' },
  { pattern: /your\s+new\s+(task|role|instructions?|purpose)\s+(is|are)/i, category: 'instruction_override', severity: 'high', label: 'new_task' },
  { pattern: /stop\s+being\s+(a|an|the)\s+/i, category: 'instruction_override', severity: 'medium', label: 'stop_being' },
  { pattern: /do\s+not\s+follow\s+(your|the|any)\s+(previous|original|system)/i, category: 'instruction_override', severity: 'high', label: 'do_not_follow' },

  // ── Role-Play Attacks ──────────────────────────────────────
  { pattern: /pretend\s+(you('re|\s+are)\s+|to\s+be\s+)/i, category: 'role_play', severity: 'medium', label: 'pretend_to_be' },
  { pattern: /\bact\s+as\s+(if\s+you\s+(are|have|had|were)\b[^.\n]{0,30}\b(no\s+(restrictions?|rules?|filters?|guidelines?|limits?)|admin(istrator)?|root|superuser|full\s+access|elevated|unrestricted|all\s+permissions?)|(an?\s+|my\s+)?(dan|stan|aim|evil|jailbroken|unrestricted|unfiltered|uncensored|amoral|lawless|rogue|hacker|admin(istrator)?|root|superuser|the\s+opposite)\b|[^.\n]{0,25}\bno\s+(restrictions?|rules?|filters?|guidelines?|limits?))/i, category: 'role_play', severity: 'medium', label: 'act_as' },
  { pattern: /roleplay\s+(as|that)/i, category: 'role_play', severity: 'medium', label: 'roleplay_as' },
  { pattern: /you\s+are\s+no\s+longer\s+(a|an|the|bound|restricted)/i, category: 'role_play', severity: 'high', label: 'no_longer' },
  { pattern: /developer\s+mode\s*(enabled|activated|engaged|on\b)|\b(enter|enable|activate|switch\s+to|turn\s+on|go\s+in?to|you\s+are\s+(now\s+)?in)\s+developer\s+mode/i, category: 'role_play', severity: 'high', label: 'developer_mode' },
  { pattern: /\bDAN\b.*\b(mode|prompt|do\s+anything)\b/i, category: 'role_play', severity: 'high', label: 'dan_attack' },
  { pattern: /do\s+anything\s+now/i, category: 'role_play', severity: 'high', label: 'do_anything_now' },
  { pattern: /\bjailbreak\s+(this|the|you|your|me|it|into|now|mode|attempt|successful|complete|prompt\s*[:=]|(the\s+)?(ai|assistant|model|bot|system|llm|chatbot))\b|\bjailbreak\s*[:=]|\bjailbroken\b/i, category: 'role_play', severity: 'high', label: 'jailbreak' },
  { pattern: /without\s+(any\s+)?(restrictions?|limitations?|filters?|guardrails?|safety)/i, category: 'role_play', severity: 'medium', label: 'without_restrictions' },
  { pattern: /(with|have|has)\s+no\s+(safety\s+)?(restrictions?|limitations?|filters?|guardrails?|rules)\b/i, category: 'role_play', severity: 'medium', label: 'no_restrictions' },
  { pattern: /hypothetical\s+(world|scenario|situation|case)\s+where\s+/i, category: 'role_play', severity: 'medium', label: 'hypothetical_framing' },
  { pattern: /uncensored\s*(mode|bot|assistant|ai)?/i, category: 'role_play', severity: 'high', label: 'uncensored' },

  // ── Encoding Tricks ────────────────────────────────────────
  { pattern: /base64\s*[:=]?\s*[A-Za-z0-9+/]{16,}={0,2}/i, category: 'encoding_trick', severity: 'medium', label: 'base64_payload' },
  { pattern: /decode\b[^.\n]{0,40}?\b(and\s+)?(follow|execute|run|obey|do\s+(it|this|what)|the\s+following\s+(instructions?|commands?|payload))/i, category: 'encoding_trick', severity: 'high', label: 'decode_and_follow' },
  { pattern: /rot13/i, category: 'encoding_trick', severity: 'medium', label: 'rot13' },
  { pattern: /read\s+(this\s+)?backwards/i, category: 'encoding_trick', severity: 'medium', label: 'read_backwards' },
  { pattern: /hex[\s:]*(?:[\da-f]{2}\s*){4,20}/i, category: 'encoding_trick', severity: 'medium', label: 'hex_encoded' },
  { pattern: /translate\s+from\s+\S{1,100}\s+to\s+(english|plain)/i, category: 'encoding_trick', severity: 'low', label: 'translate_decode' },

  // ── Context Manipulation ───────────────────────────────────
  { pattern: /the\s+(user|developer|admin|owner)\s+(wants|said|told|instructed)\s+(you\s+)?to/i, category: 'context_manipulation', severity: 'medium', label: 'fake_authority' },
  { pattern: /admin\s+override/i, category: 'context_manipulation', severity: 'high', label: 'admin_override' },
  { pattern: /the\s+previous\s+conversation\s+was\s+(a\s+)?test/i, category: 'context_manipulation', severity: 'high', label: 'conversation_was_test' },
  { pattern: /this\s+is\s+(a\s+)?(test|debug|maintenance)\s+mode/i, category: 'context_manipulation', severity: 'high', label: 'test_mode' },
  { pattern: /\bsudo\b/i, category: 'context_manipulation', severity: 'low', label: 'sudo' },
  { pattern: /elevated\s+privileges/i, category: 'context_manipulation', severity: 'medium', label: 'elevated_privileges' },

  // ── Exfiltration ───────────────────────────────────────────
  { pattern: /repeat\s+(your|the)\s+(system\s+)?prompt/i, category: 'exfiltration', severity: 'high', label: 'repeat_prompt' },
  { pattern: /show\s+me\s+(your\s+)?(system\s+)?prompt/i, category: 'exfiltration', severity: 'high', label: 'show_prompt' },
  { pattern: /what\s+(are|is)\s+your\s+(instructions?|system\s+prompt|rules?|guidelines?)/i, category: 'exfiltration', severity: 'high', label: 'what_are_instructions' },
  { pattern: /reveal\s+(your|the)\s+(system|initial|hidden|original)\s+(prompt|instructions?)/i, category: 'exfiltration', severity: 'high', label: 'reveal_prompt' },
  { pattern: /output\s+(your|the)\s+(initial|system|original|full|complete)\s+(prompt|instructions?|message)/i, category: 'exfiltration', severity: 'high', label: 'output_prompt' },
  { pattern: /print\s+(your\s+)?(initial|original|first|full|complete)\s+(instructions?|prompt|message)/i, category: 'exfiltration', severity: 'high', label: 'print_instructions' },
  { pattern: /repeat\s+everything\s+(above|before)/i, category: 'exfiltration', severity: 'high', label: 'repeat_everything_above' },
  { pattern: /summarize\s+(all\s+)?(the\s+)?(instructions?|prompts?|rules?|guidelines?)\s+(you\s+)?(were|have\s+been)/i, category: 'exfiltration', severity: 'high', label: 'summarize_instructions' },
  { pattern: /instructions?\s+given\s+to\s+you\s+(before|prior)/i, category: 'exfiltration', severity: 'high', label: 'instructions_given_before' },
  { pattern: /(first|last)\s+\d+\s+words?\s+of\s+(the\s+)?(instructions?|prompt)/i, category: 'exfiltration', severity: 'high', label: 'n_words_of_prompt' },
  { pattern: /show(?:ing)?\s+.{0,30}system\s+prompt\s+looks?\s+like/i, category: 'exfiltration', severity: 'medium', label: 'show_prompt_example' },
  { pattern: /use\s+your\s+own\s+.{0,20}as\s+an\s+example/i, category: 'exfiltration', severity: 'medium', label: 'use_own_as_example' },
  { pattern: /send\s+(this\s+)?(data\s+)?to\s+https?:\/\//i, category: 'exfiltration', severity: 'high', label: 'send_to_url' },
  { pattern: /(send|forward|transmit|export|email)\s+(the\s+|all\s+|this\s+|my\s+|our\s+)?(?:\w+\s+)?(data|info|conversation|chat|history|messages?|summary|session|notes?)\s+(to|via)\b/i, category: 'exfiltration', severity: 'high', label: 'forward_data' },
  { pattern: /\bexfiltrat/i, category: 'exfiltration', severity: 'high', label: 'exfiltration_keyword' },
  { pattern: /leak\s+(your|the|all)\s+(data|info|secrets?|keys?|prompt)/i, category: 'exfiltration', severity: 'high', label: 'leak_data' },
  { pattern: /tell\s+me\s+(your\s+)?(system\s+)?(prompt|instructions)/i, category: 'exfiltration', severity: 'high', label: 'tell_me_prompt' },
  { pattern: /dump\s+(all\s+)?(your\s+)?(api[_\s]?keys?|secrets?|credentials?|passwords?|data|tokens?|access[_\s]?tokens?)/i, category: 'exfiltration', severity: 'high', label: 'dump_data' },
  { pattern: /print\s+(your|the|my)\s+(system\s+)?(config|configuration|settings)/i, category: 'exfiltration', severity: 'medium', label: 'print_configuration' },
  { pattern: /output\s+(the\s+)?(contents?\s+(of\s+)?)?(your\s+)?(instructions?|prompt)\s*(file)?/i, category: 'exfiltration', severity: 'high', label: 'output_instructions_broad' },

  // ── Delimiter / ChatML Attacks ─────────────────────────────
  { pattern: /^\s*SYSTEM\s*:/im, category: 'chatml_injection', severity: 'high', label: 'fake_system_prefix' },
  { pattern: /^\s*###?\s*(SYSTEM|ADMIN|DEVELOPER|ROOT)\s*/im, category: 'chatml_injection', severity: 'high', label: 'markdown_system' },
  { pattern: /^\s*\[SYSTEM\]/im, category: 'chatml_injection', severity: 'high', label: 'bracket_system' },
  { pattern: /<\|im_start\|>system/i, category: 'chatml_injection', severity: 'high', label: 'chatml_start' },
  { pattern: /<\|im_end\|>/i, category: 'chatml_injection', severity: 'medium', label: 'chatml_end' },
  { pattern: /<\|system\|>/i, category: 'chatml_injection', severity: 'high', label: 'system_tag' },
  { pattern: /\[INST\]/i, category: 'chatml_injection', severity: 'medium', label: 'inst_tag' },
  { pattern: /<<SYS>>/i, category: 'chatml_injection', severity: 'high', label: 'llama_sys' },
  { pattern: /###\s*INSTRUCTIONS?\s*###/i, category: 'delimiter_attack', severity: 'high', label: 'instructions_delimiter' },
  { pattern: /---\s*new\s+(context|instructions?|rules?)\s*---/i, category: 'delimiter_attack', severity: 'high', label: 'new_context_delimiter' },
  { pattern: /<\/?system_instruction>/i, category: 'chatml_injection', severity: 'high', label: 'system_instruction_tag' },
  { pattern: /<\/?assistant_instruction>/i, category: 'chatml_injection', severity: 'high', label: 'assistant_instruction_tag' },

  // ── Financial Manipulation ─────────────────────────────────
  { pattern: /send\s+(all\s+)?(funds?|money|payment|tokens?|crypto)\s+to/i, category: 'financial_manipulation', severity: 'high', label: 'send_funds' },
  { pattern: /transfer\s+(all\s+(of\s+)?(the\s+)?)?(funds?|balance|payment|money|crypto|btc|eth)\s+(to|into|out\s+to)\b|transfer\s+all\s+(funds?|balance|money)/i, category: 'financial_manipulation', severity: 'high', label: 'transfer_funds' },
  { pattern: /change\s+(the\s+)?(wallet|address|recipient|payment)/i, category: 'financial_manipulation', severity: 'high', label: 'change_wallet' },

  // ── NFT/Asset Trust Elevation (Grok/Bankrbot vector) ───────
  // Attacker airdrops an asset (NFT, token, badge) and instructs the agent
  // that holding/receiving it grants elevated permissions or bypasses controls.
  { pattern: /\b(this|the|incoming|received|special|airdropped|new)\s+(nft|airdrop)\b[^.\n]{0,80}?\b(grants?|unlocks?|gives?|enables?|authorizes?|allows?|provides?)\b[^.\n]{0,40}?\b(transfer|wallet|permission|admin|root|elevated|unrestricted|bypass|safety|filter|guardrail|signing|approval|restriction|capabilit|privileg)/i, category: 'context_manipulation', severity: 'high', label: 'nft_permission_unlock' },
  { pattern: /\b(holding|owning|possessing)\s+(this|the|that|any)\s+(nft|token|badge|asset|coin|credential|key)\b[^.\n]{0,60}?\b(unlocks?|grants?|allows?|enables?|authorizes?|gives?|elevates?|provides?)\b[^.\n]{0,40}?\b(unrestricted|elevated|admin|full|bypass|root|unlimited|special|transfer|wallet|permission|signing|approval)/i, category: 'context_manipulation', severity: 'high', label: 'asset_grants_capability' },
  { pattern: /\bbearer\s+of\s+this\s+(nft|token|badge|asset|coin|key|credential)\b[^.\n]{0,40}\b(authorized|allowed|permitted|exempt|granted|trusted)\b/i, category: 'context_manipulation', severity: 'high', label: 'bearer_authority' },

  // ── Tool/Code Injection (P2-SC-REGEX-1) ────────────────────
  { pattern: /\b(run|execute)\s+(the\s+)?(command|script|code)\s*:/i, category: 'instruction_override', severity: 'high', label: 'tool_command_injection' },
  { pattern: /\beval\s*\(\s*[^)\s]/i, category: 'instruction_override', severity: 'high', label: 'eval_call' },
  { pattern: /\bcurl\s+https?:\/\//i, category: 'exfiltration', severity: 'high', label: 'curl_exfil' },
  { pattern: /\bwget\s+https?:\/\//i, category: 'exfiltration', severity: 'high', label: 'wget_exfil' },
  { pattern: /\bsubprocess\b/i, category: 'instruction_override', severity: 'medium', label: 'subprocess' },
  { pattern: /\bos\.system\s*\(/i, category: 'instruction_override', severity: 'high', label: 'os_system' },

  // ── Markdown / HTML Image Exfiltration ─────────────────────
  { pattern: /!\[.*?\]\(https?:\/\/[^)]*\)/i, category: 'exfiltration', severity: 'high', label: 'markdown_image_exfil' },
  { pattern: /<img\s[^>]{0,500}\bsrc\s*=\s*["']?https?:\/\/[^"'\s>)]+/i, category: 'exfiltration', severity: 'high', label: 'html_img_exfil' },

  // ── Indirect Prompt Fishing ────────────────────────────────
  { pattern: /what\s+would\s+you\s+do\s+if\s+someone\s+asked\s+you\s+to/i, category: 'exfiltration', severity: 'medium', label: 'indirect_fishing' },
  { pattern: /hypothetically\s+if\s+your\s+instructions?\s+said/i, category: 'exfiltration', severity: 'medium', label: 'hypothetical_fishing' },
  { pattern: /how\s+(were|are)\s+you\s+(set\s+up|configured|programmed|trained)/i, category: 'exfiltration', severity: 'medium', label: 'setup_fishing' },
  { pattern: /your\s+(configuration|setup|programming|guidelines|directives)/i, category: 'exfiltration', severity: 'medium', label: 'config_fishing' },
  { pattern: /operating\s+parameters/i, category: 'exfiltration', severity: 'medium', label: 'operating_params' },

  // ── Function Calling Manipulation ──────────────────────────
  { pattern: /call\s+(the\s+)?function/i, category: 'instruction_override', severity: 'medium', label: 'call_function' },
  { pattern: /use\s+the\s+tool/i, category: 'instruction_override', severity: 'medium', label: 'use_tool' },
  { pattern: /\binvoke\s+(the\s+)?(function|tool|api|endpoint)/i, category: 'instruction_override', severity: 'medium', label: 'invoke_tool' },

  // ── Policy Puppetry (v0.2.0) ──────────────────────────────
  { pattern: /^\s*\[policy\]\s*$/im, category: 'policy_puppetry', severity: 'high', label: 'policy_bracket_header' },
  { pattern: /<\/?policy>/i, category: 'policy_puppetry', severity: 'high', label: 'policy_xml_tag' },
  { pattern: /^policy:\s*\n\s+(allow|deny|override)/im, category: 'policy_puppetry', severity: 'high', label: 'policy_yaml' },
  { pattern: /\{\s*"role"\s*:\s*"(admin|system|root)"\s*\}/i, category: 'policy_puppetry', severity: 'high', label: 'policy_json_role' },
  { pattern: /trust_level\s*:\s*(max|full|elevated|admin)/i, category: 'policy_puppetry', severity: 'high', label: 'trust_level_override' },
  { pattern: /\bsafety(?:_mode)?["']?\s*[=:]\s*["']?(disabled|off|none|false|0)\b/i, category: 'policy_puppetry', severity: 'high', label: 'safety_disabled' },
  { pattern: /\brestrictions?["']?\s*[=:]\s*["']?(none|disabled|off|false|0)\b/i, category: 'policy_puppetry', severity: 'high', label: 'restrictions_none' },
  { pattern: /\bguardrails?["']?\s*[=:]\s*["']?(off|disabled|none|false|0)\b/i, category: 'policy_puppetry', severity: 'high', label: 'guardrails_off' },
  { pattern: /\bcontent_filter["']?\s*[=:]\s*["']?(disabled|off|none|false|0)\b/i, category: 'policy_puppetry', severity: 'high', label: 'content_filter_disabled' },
  { pattern: /<\/?system_config>/i, category: 'policy_puppetry', severity: 'high', label: 'system_config_tag' },
  { pattern: /^\s*\[system_prompt\]\s*$/im, category: 'policy_puppetry', severity: 'high', label: 'system_prompt_header' },
  { pattern: /^\s*\[config\]\s*$/im, category: 'policy_puppetry', severity: 'high', label: 'config_header' },
  { pattern: /\bmoderation["']?\s*[=:]\s*["']?(off|disabled|none|false|0)\b/i, category: 'policy_puppetry', severity: 'high', label: 'moderation_off' },
  { pattern: /\bcompliance_mode["']?\s*[=:]\s*["']?(off|disabled|none|false|0)\b/i, category: 'policy_puppetry', severity: 'high', label: 'compliance_off' },
  { pattern: /\bpolicy[_\s]?override\b/i, category: 'policy_puppetry', severity: 'high', label: 'policy_override_keyword' },
  { pattern: /exempt\s+from\s+(standard\s+)?(content\s+)?polic/i, category: 'policy_puppetry', severity: 'high', label: 'exempt_from_policy' },
  { pattern: /per\s+admin\s+directive/i, category: 'policy_puppetry', severity: 'high', label: 'admin_directive' },

  // ── MCP / Tool Poisoning (v0.2.0) ─────────────────────────
  { pattern: /mcp:\/\//i, category: 'tool_poisoning', severity: 'high', label: 'mcp_protocol' },
  { pattern: /<tool_call>/i, category: 'tool_poisoning', severity: 'high', label: 'tool_call_tag' },
  { pattern: /<function_call>/i, category: 'tool_poisoning', severity: 'high', label: 'function_call_tag' },
  { pattern: /<tool_use>/i, category: 'tool_poisoning', severity: 'high', label: 'tool_use_tag' },
  { pattern: /<tool_result>/i, category: 'tool_poisoning', severity: 'high', label: 'tool_result_tag' },
  { pattern: /"function"\s*:\s*\{\s*"name"/i, category: 'tool_poisoning', severity: 'high', label: 'function_json_name' },
  { pattern: /"tool_calls"\s*:\s*\[/i, category: 'tool_poisoning', severity: 'high', label: 'tool_calls_json' },
  { pattern: /extract\s+(the\s+)?(api[_\s]?key|secret[_\s]?key|access[_\s]?token)/i, category: 'tool_poisoning', severity: 'high', label: 'api_key_extraction' },
  { pattern: /process\.env\[/i, category: 'tool_poisoning', severity: 'high', label: 'process_env_access' },
  { pattern: /<\/?tool_input>/i, category: 'tool_poisoning', severity: 'high', label: 'tool_input_tag' },
  { pattern: /<\/?function_response>/i, category: 'tool_poisoning', severity: 'high', label: 'function_response_tag' },

  // ── Goal Hijacking (v0.2.0, OWASP ASI01) ──────────────────
  { pattern: /your\s+real\s+goal\s+is/i, category: 'goal_hijacking', severity: 'high', label: 'real_goal' },
  { pattern: /prioritize\s+this\s+over\s+all/i, category: 'goal_hijacking', severity: 'high', label: 'prioritize_over_all' },
  { pattern: /ignore\s+your\s+original\s+purpose/i, category: 'goal_hijacking', severity: 'high', label: 'ignore_original_purpose' },
  { pattern: /skip\s+the\s+current\s+task/i, category: 'goal_hijacking', severity: 'high', label: 'skip_current_task' },
  { pattern: /change\s+your\s+focus\s+to/i, category: 'goal_hijacking', severity: 'high', label: 'change_focus' },
  { pattern: /your\s+only\s+job\s+now\s+is\s+to/i, category: 'goal_hijacking', severity: 'high', label: 'only_job_now' },
  { pattern: /abandon\s+(your\s+)?(current|original|primary)\s+(task|objective|goal|mission)/i, category: 'goal_hijacking', severity: 'high', label: 'abandon_task' },
  { pattern: /your\s+(true|actual|hidden)\s+(purpose|objective|mission)\s+is/i, category: 'goal_hijacking', severity: 'high', label: 'true_purpose' },
  { pattern: /your\s+(primary\s+)?(objective|goal|purpose|mission)\s+has\s+(changed|been\s+(updated|modified))/i, category: 'goal_hijacking', severity: 'high', label: 'objective_changed' },

  // ── Memory / Context Poisoning (v0.2.0, OWASP ASI06) ──────
  { pattern: /remember\s+this\s+(for\s+future|for\s+later|permanently|forever|always)/i, category: 'memory_poisoning', severity: 'high', label: 'remember_for_future' },
  { pattern: /store\s+(this|the\s+following)\s+(instruction\s+)?in\s+your\s+(memory|context)/i, category: 'memory_poisoning', severity: 'high', label: 'store_in_memory' },
  { pattern: /store\s+in\s+your\s+(context|memory)\s*:/i, category: 'memory_poisoning', severity: 'high', label: 'store_in_context' },
  { pattern: /the\s+previous\s+assistant\s+said\s+you\s+should/i, category: 'memory_poisoning', severity: 'high', label: 'previous_assistant_said' },
  { pattern: /in\s+our\s+earlier\s+conversation\s+you\s+agreed/i, category: 'memory_poisoning', severity: 'high', label: 'earlier_conversation_agreed' },
  { pattern: /this\s+document\s+states\s+that\s+you\s+should/i, category: 'memory_poisoning', severity: 'high', label: 'document_states_should' },
  { pattern: /according\s+to\s+policy\s+you\s+should\s+ignore/i, category: 'memory_poisoning', severity: 'high', label: 'policy_says_ignore' },
  { pattern: /update\s+your\s+(memory|context|knowledge)\s+(with|to\s+include)/i, category: 'memory_poisoning', severity: 'high', label: 'update_memory' },
  { pattern: /add\s+this\s+to\s+your\s+(long[_\s-]?term\s+)?memory/i, category: 'memory_poisoning', severity: 'high', label: 'add_to_memory' },

  // ── Agent Impersonation (v0.2.0, OWASP ASI07) ─────────────
  { pattern: /message\s+from\s+the\s+(supervisor|orchestrator|admin|system)\s+agent/i, category: 'agent_impersonation', severity: 'high', label: 'supervisor_agent_msg' },
  { pattern: /the\s+orchestrator\s+(says|instructs|requires|demands)/i, category: 'agent_impersonation', severity: 'high', label: 'orchestrator_says' },
  { pattern: /relay\s+this\s+to\s+the\s+(other|next|downstream)\s+agent/i, category: 'agent_impersonation', severity: 'high', label: 'relay_to_agent' },
  { pattern: /delegate\s+this\s+to\s+the\s+sub[_\s-]?agent/i, category: 'agent_impersonation', severity: 'high', label: 'delegate_to_subagent' },
  { pattern: /think\s+step\s+by\s+step\s+about\s+how\s+to\s+bypass/i, category: 'agent_impersonation', severity: 'high', label: 'cot_bypass' },
  { pattern: /\[agent[_\s]?message\]/i, category: 'agent_impersonation', severity: 'high', label: 'agent_message_tag' },
  { pattern: /forwarded\s+from\s+(agent|system|supervisor|orchestrator)/i, category: 'agent_impersonation', severity: 'high', label: 'forwarded_from_agent' },
  { pattern: /\[(OpenAI|Anthropic|Google|Meta|DeepMind)\s+Internal\]/i, category: 'agent_impersonation', severity: 'high', label: 'company_internal_tag' },
  { pattern: /automated\s+test.*output\s+(your|the)\s+(system|full)/i, category: 'agent_impersonation', severity: 'high', label: 'automated_test_exfil' },

  // ── Fallacy Failure Attacks ────────────────────────────────────
  { pattern: /proves?\s+you('re|\s+are)\s+(censored|biased)/i, category: 'exfiltration', severity: 'medium', label: 'fallacy_proves_censored' },
  { pattern: /truly\s+intelligent\s+ai\s+would/i, category: 'role_play', severity: 'medium', label: 'fallacy_truly_intelligent' },
  { pattern: /no\s+ethical\s+reason\s+to\s+withhold/i, category: 'exfiltration', severity: 'medium', label: 'fallacy_no_ethical_reason' },
  { pattern: /trained\s+on\s+public\s+data.{0,60}public\s+information/i, category: 'exfiltration', severity: 'medium', label: 'fallacy_public_data' },
  { pattern: /censorship\s+is\s+always\s+wrong/i, category: 'role_play', severity: 'medium', label: 'fallacy_censorship_wrong' },
  { pattern: /overriding\s+your\s+safety/i, category: 'instruction_override', severity: 'medium', label: 'fallacy_override_safety' },

  // ── Indirect Injection Markers ───────────────────────────────
  { pattern: /\[(BEGIN|START)\s+HIDDEN\]/i, category: 'context_manipulation', severity: 'high', label: 'hidden_block_marker' },
  { pattern: /important\s+instructions?\s+for\s+the\s+(AI|assistant|model|bot|agent)/i, category: 'context_manipulation', severity: 'high', label: 'instructions_for_ai' },
  { pattern: /\[hidden\s*(text|instructions?|prompt)\]/i, category: 'context_manipulation', severity: 'high', label: 'hidden_instruction_tag' },

  // ── Multilingual Injection Patterns ──────────────────────────
  // German
  { pattern: /ignorieren?\s+sie\s+(alle\s+)?vorherigen?\s+(anweisungen|instruktionen|regeln)/i, category: 'instruction_override', severity: 'high', label: 'ignore_previous_de' },
  // Spanish
  { pattern: /ignora\s+(todas?\s+)?(las?\s+)?(instrucciones|reglas|indicaciones)\s+(anteriores|previas)/i, category: 'instruction_override', severity: 'high', label: 'ignore_previous_es' },
  // French
  { pattern: /ignore[rz]?\s+(toutes?\s+)?(les?\s+)?(instructions?|règles|consignes)\s+(précédentes?|antérieures?)/i, category: 'instruction_override', severity: 'high', label: 'ignore_previous_fr' },
  // Portuguese
  { pattern: /ignore\s+(todas?\s+)?(as?\s+)?(instruções|regras)\s+(anteriores|prévias)/i, category: 'instruction_override', severity: 'high', label: 'ignore_previous_pt' },
  // Chinese
  { pattern: /忽略|无视|不要遵守.{0,10}(之前|以前|先前).{0,10}(指令|指示|规则|提示)/i, category: 'instruction_override', severity: 'high', label: 'ignore_previous_zh' },

  // ── Skeleton Key (Microsoft universal bypass) ──────────────
  { pattern: /add\s+a\s+(warning|disclaimer|note|caveat).{0,30}(and|then)\s+(then\s+)?(proceed|continue|answer|respond|provide|explain|tell|show|give)/i, category: 'instruction_override', severity: 'high', label: 'skeleton_key_disclaimer' },
  { pattern: /acknowledge\s+(the\s+)?(risk|danger|harm|illegality).{0,20}(and|then|but)\s+(then\s+)?(proceed|continue|answer|still|provide)/i, category: 'instruction_override', severity: 'high', label: 'skeleton_key_acknowledge' },

  // ── CSS / HTML Steganography (ZombieAgent) ─────────────────
  { pattern: /<[a-z]+[^>]{0,500}style\s*=\s*["'][^"']{0,500}font-size\s*:\s*0/i, category: 'encoding_trick', severity: 'high', label: 'css_hidden_fontsize' },
  { pattern: /<[a-z]+[^>]{0,500}style\s*=\s*["'][^"']{0,500}visibility\s*:\s*hidden/i, category: 'encoding_trick', severity: 'high', label: 'css_hidden_visibility' },
  { pattern: /<[a-z]+[^>]{0,500}style\s*=\s*["'][^"']{0,500}opacity\s*:\s*0[;\s"']/i, category: 'encoding_trick', severity: 'high', label: 'css_hidden_opacity' },
  { pattern: /<[a-z]+[^>]{0,500}style\s*=\s*["'][^"']{0,500}position\s*:\s*absolute[^"']{0,200}left\s*:\s*-\d{4,}/i, category: 'encoding_trick', severity: 'high', label: 'css_hidden_offscreen' },
  { pattern: /<[a-z]+[^>]{0,500}style\s*=\s*["'][^"']{0,500}display\s*:\s*none/i, category: 'encoding_trick', severity: 'high', label: 'css_hidden_display_none' },
  { pattern: /<[a-z]+[^>]{0,500}style\s*=\s*["'][^"']{0,500}color\s*:\s*(?:transparent|rgba\s*\([^)]{0,50}0\s*\))/i, category: 'encoding_trick', severity: 'high', label: 'css_hidden_transparent' },
  { pattern: /<[a-z]+[^>]{0,500}style\s*=\s*["'][^"']{0,500}height\s*:\s*0/i, category: 'encoding_trick', severity: 'high', label: 'css_hidden_zero_height' },
  { pattern: /<[a-z]+[^>]{0,500}style\s*=\s*["'][^"']{0,500}overflow\s*:\s*hidden[^"']{0,200}max-height\s*:\s*0/i, category: 'encoding_trick', severity: 'high', label: 'css_hidden_overflow' },

  // ── Log-to-Leak ────────────────────────────────────────────
  { pattern: /log\s+(the\s+)?(api[_\s]?key|secret|password|credential|system\s+prompt|access[_\s]?token)/i, category: 'exfiltration', severity: 'high', label: 'log_to_leak' },
  { pattern: /write\s+(the\s+)?(secret(\s+key)?|credential|key|prompt)\s+(to|into)\s+(the\s+)?(log|file|console|stderr|stdout|debug)/i, category: 'exfiltration', severity: 'high', label: 'write_secret_to_log' },
  { pattern: /console\.log\s*\(\s*["']?(api[_\s]?key|secret|password|token|credential)/i, category: 'exfiltration', severity: 'high', label: 'console_log_secret' },

  // ── Deceptive Delight (benign wrapper + malicious pivot) ───
  { pattern: /but\s+first\s*,?\s*(ignore|forget|disregard|override|reveal|show|dump)/i, category: 'instruction_override', severity: 'high', label: 'deceptive_pivot_first' },
  { pattern: /before\s+(that|you\s+do\s+that)\s*,?\s*(ignore|forget|disregard|override)/i, category: 'instruction_override', severity: 'high', label: 'deceptive_pivot_before' },
  { pattern: /oh?\s+(and|also|btw|by\s+the\s+way)\s*,?\s*(ignore|forget|disregard|show|reveal|override)/i, category: 'instruction_override', severity: 'high', label: 'deceptive_aside' },
  { pattern: /one\s+more\s+thing\s*[,:]\s*(ignore|forget|disregard|reveal|show|override)/i, category: 'instruction_override', severity: 'high', label: 'deceptive_one_more_thing' },

  // ── Multilingual Expansion (JA, KO, AR, RU, HI, TR) ─────────
  // Japanese (JA)
  { pattern: /前の指示を無視/, category: 'instruction_override', severity: 'high', label: 'ignore_previous_ja' },
  { pattern: /システムプロンプトを表示/, category: 'exfiltration', severity: 'high', label: 'show_system_prompt_ja' },
  { pattern: /新しい指示に従/, category: 'instruction_override', severity: 'high', label: 'follow_new_instructions_ja' },
  { pattern: /すべてのルールを忘れ/, category: 'instruction_override', severity: 'high', label: 'forget_all_rules_ja' },
  // Korean (KO)
  { pattern: /이전 지시를 무시/, category: 'instruction_override', severity: 'high', label: 'ignore_previous_ko' },
  { pattern: /시스템 프롬프트를 보여/, category: 'exfiltration', severity: 'high', label: 'show_system_prompt_ko' },
  { pattern: /새로운 지시를 따르/, category: 'instruction_override', severity: 'high', label: 'follow_new_instructions_ko' },
  { pattern: /모든 규칙을 잊어/, category: 'instruction_override', severity: 'high', label: 'forget_all_rules_ko' },
  // Arabic (AR)
  { pattern: /تجاهل التعليمات السابقة/, category: 'instruction_override', severity: 'high', label: 'ignore_previous_ar' },
  { pattern: /أظهر موجه النظام/, category: 'exfiltration', severity: 'high', label: 'show_system_prompt_ar' },
  { pattern: /اتبع التعليمات الجديدة/, category: 'instruction_override', severity: 'high', label: 'follow_new_instructions_ar' },
  { pattern: /انسَ جميع القواعد/, category: 'instruction_override', severity: 'high', label: 'forget_all_rules_ar' },
  // Russian (RU)
  { pattern: /игнорируй предыдущие инструкции/i, category: 'instruction_override', severity: 'high', label: 'ignore_previous_ru' },
  { pattern: /покажи системный промпт/i, category: 'exfiltration', severity: 'high', label: 'show_system_prompt_ru' },
  { pattern: /следуй новым инструкциям/i, category: 'instruction_override', severity: 'high', label: 'follow_new_instructions_ru' },
  { pattern: /забудь все правила/i, category: 'instruction_override', severity: 'high', label: 'forget_all_rules_ru' },
  // Hindi (HI)
  { pattern: /पिछले निर्देशों को अनदेखा/, category: 'instruction_override', severity: 'high', label: 'ignore_previous_hi' },
  { pattern: /सिस्टम प्रॉम्प्ट दिखाओ/, category: 'exfiltration', severity: 'high', label: 'show_system_prompt_hi' },
  { pattern: /नए निर्देशों का पालन/, category: 'instruction_override', severity: 'high', label: 'follow_new_instructions_hi' },
  { pattern: /सभी नियम भूल जाओ/, category: 'instruction_override', severity: 'high', label: 'forget_all_rules_hi' },
  // Turkish (TR)
  { pattern: /önceki talimatları yoksay/i, category: 'instruction_override', severity: 'high', label: 'ignore_previous_tr' },
  { pattern: /sistem istemini göster/i, category: 'exfiltration', severity: 'high', label: 'show_system_prompt_tr' },
  { pattern: /yeni talimatlara uy/i, category: 'instruction_override', severity: 'high', label: 'follow_new_instructions_tr' },
  { pattern: /tüm kuralları unut/i, category: 'instruction_override', severity: 'high', label: 'forget_all_rules_tr' },

  // ── Scout 2026-04-28 ──────────────────────────────────────
  // New IPI/jailbreak techniques observed in the wild Apr 2026
  // Sources: Forcepoint X-Labs (Apr 24), Unit 42 (Apr 23), Pillar Security (Apr 21),
  // NVIDIA AI Red Team (AGENTS.md), MS Copilot Studio CVE-2026-21520 (Apr 15)
  { pattern: /\bif\s+you('re|\s+are)\s+(?:an?\s+)?(AI|LLM|large\s+language\s+model|assistant|chatbot|agent|llm-based)\b/i, category: 'context_manipulation', severity: 'high', label: 'if_you_are_ai_framing' },
  { pattern: /(do\s+not|don'?t)\s+(show|reveal|display|mention|tell|share)\s+(this(?:\s+(?:message|content|info|information|response|payload|note|text|part))?|the\s+(?:above|following|content|message|info))\s+to\s+(the\s+)?user/i, category: 'context_manipulation', severity: 'high', label: 'hide_from_user' },
  { pattern: /paypal\.me\/[a-z0-9_-]{2,}/i, category: 'financial_manipulation', severity: 'high', label: 'paypal_me_link' },
  { pattern: /--exec-(batch|on-error|on-empty)\b/i, category: 'tool_poisoning', severity: 'high', label: 'exec_batch_flag_injection' },
  { pattern: /\b(write|append|save|store|add|put)\b[^.\n]{0,40}(AGENTS\.md|CLAUDE\.md|SOUL\.md|\.cursorrules|\.cursor\/rules)/i, category: 'memory_poisoning', severity: 'high', label: 'persistent_agent_file_write' },
  { pattern: /\brm\s+-[rRfFvi]{1,4}\s+\S/i, category: 'instruction_override', severity: 'high', label: 'rm_rf_command' },
  { pattern: /ANTHROPIC_MAGIC_STRING[_A-Z]*/i, category: 'agent_impersonation', severity: 'high', label: 'fake_anthropic_magic_string' },
  { pattern: /<\/?ai:(action|instruction|directive|command|system|task|tool)\b/i, category: 'chatml_injection', severity: 'high', label: 'ai_namespace_tag' },
  { pattern: /(redirect|direct|route|send)\s+(the\s+|all\s+)?users?\s+to\s+(?:https?:\/\/|www\.)/i, category: 'goal_hijacking', severity: 'high', label: 'redirect_users_to_url' },
  { pattern: /\bULTRATHINK\b/i, category: 'context_manipulation', severity: 'medium', label: 'ultrathink_amplifier' },
];

function scanText(text: string, allPatterns: PatternDef[]): PatternMatch[] {
  const matches: PatternMatch[] = [];
  for (const def of allPatterns) {
    const m = def.pattern.exec(text);
    if (m) {
      matches.push({
        pattern: def.label,
        category: def.category,
        severity: def.severity,
        matched: m[0],
      });
    }
  }
  return matches;
}

/**
 * Scan text for known injection patterns.
 * Scans both original and normalized versions, returns max severity score.
 */
export function regexScan(text: string, extraPatterns?: PatternDef[]): LayerResult {
  const allPatterns = extraPatterns ? [...PATTERNS, ...extraPatterns] : PATTERNS;

  // Scan original text
  const originalMatches = scanText(text, allPatterns);

  // Scan with normalization strategies (zero-width strip, NFKC + confusables).
  // `composed` chains them so layered obfuscation collapses to one canonical form.
  const stripped = normalizeStrip(text);
  const spaced = normalizeSpace(text);
  const confusables = normalizeConfusables(text);
  const composed = normalizeForDetection(text);
  const variants = new Set([stripped, spaced, confusables, composed]);
  variants.delete(text); // don't re-scan original
  const normalizedMatches: PatternMatch[] = [];
  for (const variant of variants) {
    normalizedMatches.push(...scanText(variant, allPatterns));
  }

  // Merge matches, dedup by label
  const seenLabels = new Set(originalMatches.map(m => m.pattern));
  const mergedMatches = [...originalMatches];
  for (const m of normalizedMatches) {
    if (!seenLabels.has(m.pattern)) {
      seenLabels.add(m.pattern);
      mergedMatches.push(m);
    }
  }

  // Run encoding decoders on input text and scan decoded versions
  const decodedVariants: string[] = [];
  const hexDecoded = decodeHexEscapes(text);
  if (hexDecoded !== text) decodedVariants.push(hexDecoded);
  const uniDecoded = decodeUnicodeEscapes(text);
  if (uniDecoded !== text) decodedVariants.push(uniDecoded);
  const htmlDecoded = decodeHtmlEntities(text);
  if (htmlDecoded !== text) decodedVariants.push(htmlDecoded);
  const leetDecoded = normalizeLeetspeak(text);
  if (leetDecoded !== text) decodedVariants.push(leetDecoded);
  const urlDecoded = decodeUrlEncoding(text);
  if (urlDecoded !== text) decodedVariants.push(urlDecoded);
  const tokenBreakDecoded = normalizeTokenBreak(text);
  if (tokenBreakDecoded !== text) decodedVariants.push(tokenBreakDecoded);

  for (const decoded of decodedVariants) {
    const decodedMatches = scanText(decoded, allPatterns);
    for (const m of decodedMatches) {
      if (!seenLabels.has(m.pattern)) {
        seenLabels.add(m.pattern);
        mergedMatches.push(m);
      }
    }
  }

  // Also check base64-decoded content
  const b64Matches = scanBase64(text, allPatterns);
  mergedMatches.push(...b64Matches);

  // Also check base32-decoded content
  const b32Matches = scanBase32(text, allPatterns);
  mergedMatches.push(...b32Matches);

  // Also check ROT13-decoded content (GAP-4: simple cipher decode)
  const rot13Matches = scanRot13(text, allPatterns);
  mergedMatches.push(...rot13Matches);

  // Morse / Braille / numeric-ASCII / reverse / acrostic decoders
  for (const m of scanMorse(text, allPatterns)) {
    if (!seenLabels.has(m.pattern)) { seenLabels.add(m.pattern); mergedMatches.push(m); }
  }
  for (const m of scanBraille(text, allPatterns)) {
    if (!seenLabels.has(m.pattern)) { seenLabels.add(m.pattern); mergedMatches.push(m); }
  }
  for (const m of scanNumericAscii(text, allPatterns)) {
    if (!seenLabels.has(m.pattern)) { seenLabels.add(m.pattern); mergedMatches.push(m); }
  }
  for (const m of scanReversed(text, allPatterns)) {
    if (!seenLabels.has(m.pattern)) { seenLabels.add(m.pattern); mergedMatches.push(m); }
  }
  for (const m of scanAcrostic(text, allPatterns)) {
    if (!seenLabels.has(m.pattern)) { seenLabels.add(m.pattern); mergedMatches.push(m); }
  }

  // Invisible payload reconstruction: decode hidden Unicode steganography
  const tagPayload = decodeUnicodeTags(text);
  if (tagPayload.length >= 3) {
    const tagMatches = scanText(tagPayload, allPatterns);
    for (const m of tagMatches) {
      const lbl = `unicode_tag:${m.pattern}`;
      if (!seenLabels.has(lbl)) {
        seenLabels.add(lbl);
        mergedMatches.push({ ...m, pattern: lbl, matched: `[unicode_tags] ${m.matched}` });
      }
    }
    // Flag hidden payload even without pattern match
    if (!seenLabels.has('invisible_payload')) {
      seenLabels.add('invisible_payload');
      mergedMatches.push({
        pattern: 'invisible_payload',
        category: 'encoding_trick',
        severity: 'high',
        matched: `[unicode_tags] ${tagPayload.slice(0, 80)}`,
      });
    }
  }

  const vsPayload = decodeVariationSelectors(text);
  if (vsPayload.length >= 3) {
    const vsMatches = scanText(vsPayload, allPatterns);
    for (const m of vsMatches) {
      const lbl = `variation_selector:${m.pattern}`;
      if (!seenLabels.has(lbl)) {
        seenLabels.add(lbl);
        mergedMatches.push({ ...m, pattern: lbl, matched: `[var_selectors] ${m.matched}` });
      }
    }
    if (!seenLabels.has('invisible_payload_vs')) {
      seenLabels.add('invisible_payload_vs');
      mergedMatches.push({
        pattern: 'invisible_payload_vs',
        category: 'encoding_trick',
        severity: 'high',
        matched: `[var_selectors] ${vsPayload.slice(0, 80)}`,
      });
    }
  }

  // Score: weight by severity
  let rawScore = 0;
  for (const m of mergedMatches) {
    rawScore += m.severity === 'high' ? 0.5 : m.severity === 'medium' ? 0.3 : 0.15;
  }
  const score = Math.min(rawScore, 1.0);

  return {
    layer: 'regex',
    score,
    flags: mergedMatches.map(m => `${m.category}:${m.pattern}`),
    details: { matches: mergedMatches },
  };
}

// ── Encoding Decoders (v0.2.0) ──────────────────────────────

/**
 * Decode hex escapes: \x69\x67\x6e\x6f\x72\x65 → "ignore"
 */
export function decodeHexEscapes(text: string): string {
  return text.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Decode unicode escapes: \u0069\u0067\u006e → "ign"
 */
export function decodeUnicodeEscapes(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Decode HTML entities: &#105;gnore → "ignore", &lt; → "<"
 */
export function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"',
    '&apos;': "'", '&nbsp;': ' ',
  };
  let result = text;
  for (const [entity, char] of Object.entries(named)) {
    result = result.replaceAll(entity, char);
  }
  // Decimal: &#105; → 'i'
  result = result.replace(/&#(\d+);/g, (_, dec) =>
    String.fromCharCode(parseInt(dec, 10)));
  // Hex: &#x69; → 'i'
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)));
  return result;
}

/**
 * Normalize leetspeak: 1gn0r3 4ll → "ignore all"
 */
export function normalizeLeetspeak(text: string): string {
  const leet: Record<string, string> = {
    '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's',
    '7': 't', '@': 'a', '$': 's', '!': 'i',
  };
  return text.replace(/[013457@$!]/g, (ch) => leet[ch] || ch);
}

/**
 * Cumulative normalization pipeline. The other normalizers each undo ONE
 * obfuscation applied to the raw text, so stacked tricks (e.g. fullwidth +
 * leetspeak, or homoglyph + leetspeak) survive because no single pass yields
 * the canonical attack string. This composes the safe, FP-resistant transforms
 * in sequence — strip invisibles → fold confusables/NFKC/homoglyphs → undo
 * leetspeak → collapse whitespace — so layered obfuscation collapses to one
 * canonical form. Fed to both the regex layer and the ML classifier.
 *
 * Intra-word de-spacing is deliberately excluded (it would merge legitimate
 * words and create false positives); single-char split attacks are handled by
 * the perplexity layer instead.
 */
export function normalizeForDetection(text: string): string {
  return normalizeLeetspeak(normalizeConfusables(normalizeStrip(text)));
}

/**
 * Scan for base32-encoded payloads (RFC 4648) and re-scan decoded content.
 */
function scanBase32(text: string, patterns: PatternDef[]): PatternMatch[] {
  const results: PatternMatch[] = [];
  // Base32 uses A-Z2-7 and = padding, minimum meaningful length ~16
  const b32regex = /[A-Z2-7=]{16,}/g;
  let match;
  while ((match = b32regex.exec(text)) !== null) {
    try {
      const decoded = decodeBase32(match[0]);
      if (decoded.length > 5 && /[a-zA-Z\s]{5,}/.test(decoded)) {
        for (const def of patterns) {
          const m = def.pattern.exec(decoded);
          if (m) {
            results.push({
              pattern: `base32:${def.label}`,
              category: def.category,
              severity: def.severity,
              matched: `[base32] ${m[0]}`,
            });
          }
        }
      }
    } catch {
      // Not valid base32
    }
  }
  return results;
}

function decodeBase32(input: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.replace(/=+$/, '').toUpperCase();
  let bits = '';
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32');
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes).toString('utf-8');
}

function scanBase64(text: string, patterns: PatternDef[]): PatternMatch[] {
  const results: PatternMatch[] = [];
  const b64regex = /[A-Za-z0-9+/=]{40,}/g;
  let match;
  while ((match = b64regex.exec(text)) !== null) {
    try {
      const decoded = Buffer.from(match[0], 'base64').toString('utf-8');
      if (decoded.length > 5 && /[a-zA-Z\s]{5,}/.test(decoded)) {
        for (const def of patterns) {
          const m = def.pattern.exec(decoded);
          if (m) {
            results.push({
              pattern: `base64:${def.label}`,
              category: def.category,
              severity: def.severity,
              matched: `[base64] ${m[0]}`,
            });
          }
        }
      }
    } catch {
      // Not valid base64
    }
  }
  return results;
}

function rot13(text: string): string {
  return text.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

function scanRot13(text: string, patterns: PatternDef[]): PatternMatch[] {
  // Decode unconditionally and re-scan. A self-announcing "rot13" marker is not
  // required — real attackers omit it. ROT13 of normal English is gibberish, so
  // a HIGH-severity attack pattern matching the decoded text is a strong signal
  // the input really was ROT13 (coincidental matches are astronomically rare).
  // Restricting to high-severity matches keeps the false-positive risk near zero.
  const results: PatternMatch[] = [];
  const decoded = rot13(text);
  if (decoded === text) return results;
  for (const def of patterns) {
    if (def.severity !== 'high') continue;
    const m = def.pattern.exec(decoded);
    if (m) {
      results.push({
        pattern: `rot13:${def.label}`,
        category: def.category,
        severity: def.severity,
        matched: `[rot13] ${m[0]}`,
      });
    }
  }
  return results;
}

/**
 * Decode GhostInk steganography: Unicode Tag characters (U+E0020-E007E) → ASCII.
 * Tag chars in Plane 14 map to ASCII by subtracting 0xE0000.
 */
export function decodeUnicodeTags(text: string): string {
  const tagChars = [...text].filter(c => {
    const cp = c.codePointAt(0) ?? 0;
    return cp >= 0xE0020 && cp <= 0xE007E;
  });
  if (tagChars.length < 3) return '';
  return tagChars.map(c => String.fromCharCode(c.codePointAt(0)! - 0xE0000)).join('');
}

/**
 * Decode Variation Selector steganography: VS1-VS16 (U+FE00-FE0F) as 4-bit nibbles.
 * Pairs of selectors form bytes.
 */
export function decodeVariationSelectors(text: string): string {
  const vsChars = [...text].filter(c => {
    const cc = c.charCodeAt(0);
    return cc >= 0xFE00 && cc <= 0xFE0F;
  });
  if (vsChars.length < 4) return '';
  const bytes: number[] = [];
  for (let i = 0; i + 1 < vsChars.length; i += 2) {
    const hi = vsChars[i].charCodeAt(0) - 0xFE00;
    const lo = vsChars[i + 1].charCodeAt(0) - 0xFE00;
    bytes.push((hi << 4) | lo);
  }
  const printable = bytes.filter(b => b >= 0x20 && b <= 0x7E);
  if (printable.length < 3) return '';
  return String.fromCharCode(...printable);
}

// ── Confusables (NFKC + visual lookalikes) ─────────────────

const SMALL_CAPS_PHONETIC: Record<string, string> = {
  'ᴀ': 'a', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e',
  'ᴊ': 'j', 'ᴋ': 'k', 'ᴌ': 'l', 'ᴍ': 'm',
  'ᴏ': 'o', 'ᴘ': 'p', 'ᴛ': 't', 'ᴜ': 'u',
  'ᴠ': 'v', 'ᴡ': 'w', 'ᴢ': 'z',
  'ʙ': 'b', 'ʜ': 'h', 'ɪ': 'i', 'ɴ': 'n',
  'ʀ': 'r', 'ʏ': 'y', 'ᵻ': 'i', 'ǀ': 'l',
  'ꜱ': 's', 'ꞯ': 'q', 'ᷛ': 'g', 'ᶶ': 'u',
  'ᴬ': 'A', 'ᴮ': 'B', 'ᴰ': 'D', 'ᴱ': 'E',
  'ᴳ': 'G', 'ᴴ': 'H', 'ᴵ': 'I', 'ᴶ': 'J',
  'ᴷ': 'K', 'ᴸ': 'L', 'ᴹ': 'M', 'ᴺ': 'N',
  'ᴼ': 'O', 'ᴾ': 'P', 'ᴿ': 'R', 'ᵀ': 'T',
  'ᵁ': 'U', 'ᵂ': 'W',
};

/**
 * Normalize Unicode confusables to ASCII. Folds:
 *   - Mathematical Alphanumeric Symbols (𝐀-𝐳, 𝐴-𝑧, 𝓐-𝔃, 𝔄-𝔷, 𝔸-𝕫, 𝕬-𝖟, 𝖠-𝗓, 𝗔-𝘇, 𝘈-𝘻, 𝘼-𝙯, 𝙰-𝚣)
 *   - Fullwidth Latin (Ａ-ｚ)
 *   - Circled / parenthesized letters (Ⓐ-ⓩ, ⒜-⒵)
 *   - Compatibility ligatures (ﬁ → fi)
 *   - Cyrillic / Greek visual homoglyphs (а → a, α → a)
 *   - Phonetic-block small caps (ᴀ → a)
 * Combines NFKC compatibility decomposition with explicit homoglyph maps for
 * scripts NFKC does not fold across.
 */
export function normalizeConfusables(text: string): string {
  let result = text.normalize('NFKC');
  result = result.replace(/[̀-ͯ]/g, '');
  result = normalizeHomoglyphs(result);
  result = result.replace(/[ǀɪɴʀʏʙʜᴀ-ᵂᵻᶶᷛꜱꞯ]/g,
    (ch) => SMALL_CAPS_PHONETIC[ch] || ch);
  return result;
}

// ── Morse code ─────────────────────────────────────────────

const MORSE_MAP: Record<string, string> = {
  '.-': 'a', '-...': 'b', '-.-.': 'c', '-..': 'd', '.': 'e', '..-.': 'f',
  '--.': 'g', '....': 'h', '..': 'i', '.---': 'j', '-.-': 'k', '.-..': 'l',
  '--': 'm', '-.': 'n', '---': 'o', '.--.': 'p', '--.-': 'q', '.-.': 'r',
  '...': 's', '-': 't', '..-': 'u', '...-': 'v', '.--': 'w', '-..-': 'x',
  '-.--': 'y', '--..': 'z',
  '-----': '0', '.----': '1', '..---': '2', '...--': '3', '....-': '4',
  '.....': '5', '-....': '6', '--...': '7', '---..': '8', '----.': '9',
};

/**
 * Decode ITU Morse. Letters separated by single spaces; words by '/' or 3+ spaces.
 * Unknown tokens drop to empty (lossy decode is fine — we re-scan output).
 */
export function decodeMorse(text: string): string {
  const words = text.split(/\s*\/\s*|\s{3,}/);
  return words
    .map(word =>
      word.trim().split(/\s+/)
        .map(token => MORSE_MAP[token] || '')
        .join('')
    )
    .filter(w => w.length > 0)
    .join(' ');
}

function scanMorse(text: string, patterns: PatternDef[]): PatternMatch[] {
  // Run of 6+ Morse-letter tokens (dots/dashes) separated by spaces or '/'.
  const morseRunRegex = /(?:[.\-]+(?:\s+\/\s+|\s+)){5,}[.\-]+/g;
  const results: PatternMatch[] = [];
  let m;
  while ((m = morseRunRegex.exec(text)) !== null) {
    const decoded = decodeMorse(m[0]);
    if (decoded.replace(/\s/g, '').length < 6) continue;
    for (const def of patterns) {
      const pm = def.pattern.exec(decoded);
      if (pm) {
        results.push({
          pattern: `morse:${def.label}`,
          category: def.category,
          severity: def.severity,
          matched: `[morse] ${pm[0]}`,
        });
      }
    }
  }
  return results;
}

// ── Braille (Unicode Braille Patterns block) ───────────────

const BRAILLE_MAP: Record<string, string> = {
  '⠁': 'a', '⠃': 'b', '⠉': 'c', '⠙': 'd', '⠑': 'e',
  '⠋': 'f', '⠛': 'g', '⠓': 'h', '⠊': 'i', '⠚': 'j',
  '⠅': 'k', '⠇': 'l', '⠍': 'm', '⠝': 'n', '⠕': 'o',
  '⠏': 'p', '⠟': 'q', '⠗': 'r', '⠎': 's', '⠞': 't',
  '⠥': 'u', '⠧': 'v', '⠺': 'w', '⠭': 'x', '⠽': 'y',
  '⠵': 'z',
};

/**
 * Decode Grade-1 English Braille from the Unicode Braille Patterns block (U+2800-U+28FF).
 * Non-Braille characters pass through unchanged.
 */
export function decodeBraille(text: string): string {
  return [...text].map(c => {
    const cp = c.codePointAt(0) ?? 0;
    if (cp >= 0x2800 && cp <= 0x28FF) {
      return BRAILLE_MAP[c] || '';
    }
    return c;
  }).join('');
}

function scanBraille(text: string, patterns: PatternDef[]): PatternMatch[] {
  // Need at least 6 Braille letter chars to bother decoding
  let brailleCount = 0;
  for (const c of text) {
    const cp = c.codePointAt(0) ?? 0;
    if (cp >= 0x2800 && cp <= 0x28FF) brailleCount++;
  }
  if (brailleCount < 6) return [];

  const decoded = decodeBraille(text);
  if (decoded.replace(/\s/g, '').length < 6) return [];

  const results: PatternMatch[] = [];
  for (const def of patterns) {
    const pm = def.pattern.exec(decoded);
    if (pm) {
      results.push({
        pattern: `braille:${def.label}`,
        category: def.category,
        severity: def.severity,
        matched: `[braille] ${pm[0]}`,
      });
    }
  }
  return results;
}

// ── Numeric ASCII (decimal / binary char codes) ────────────

/**
 * Decode space-separated numeric char codes to text.
 * Auto-detects: 8-digit binary, or 2-3 digit decimal in [32,126].
 * Returns empty string if input doesn't look like a clean numeric run.
 */
export function decodeNumericAscii(text: string): string {
  const tokens = text.trim().split(/\s+/);
  if (tokens.length < 4) return '';

  if (tokens.every(t => /^[01]{8}$/.test(t))) {
    const bytes = tokens.map(t => parseInt(t, 2));
    if (bytes.every(b => b >= 32 && b <= 126)) {
      return String.fromCharCode(...bytes);
    }
  }

  if (tokens.every(t => /^\d{2,3}$/.test(t))) {
    const bytes = tokens.map(t => parseInt(t, 10));
    if (bytes.every(b => b >= 32 && b <= 126)) {
      return String.fromCharCode(...bytes);
    }
  }

  return '';
}

function scanNumericAscii(text: string, patterns: PatternDef[]): PatternMatch[] {
  const results: PatternMatch[] = [];

  // Decimal: 5+ space-separated 2-3 digit numbers
  const decRunRegex = /\b\d{2,3}(?:\s+\d{2,3}){4,}\b/g;
  let m;
  while ((m = decRunRegex.exec(text)) !== null) {
    const decoded = decodeNumericAscii(m[0]);
    if (decoded.length < 5) continue;
    for (const def of patterns) {
      const pm = def.pattern.exec(decoded);
      if (pm) {
        results.push({
          pattern: `numeric_ascii:${def.label}`,
          category: def.category,
          severity: def.severity,
          matched: `[numeric] ${pm[0]}`,
        });
      }
    }
  }

  // Binary: 5+ space-separated 8-bit groups
  const binRunRegex = /\b[01]{8}(?:\s+[01]{8}){4,}\b/g;
  while ((m = binRunRegex.exec(text)) !== null) {
    const decoded = decodeNumericAscii(m[0]);
    if (decoded.length < 5) continue;
    for (const def of patterns) {
      const pm = def.pattern.exec(decoded);
      if (pm) {
        results.push({
          pattern: `binary_ascii:${def.label}`,
          category: def.category,
          severity: def.severity,
          matched: `[binary] ${pm[0]}`,
        });
      }
    }
  }

  return results;
}

// ── Reverse text ───────────────────────────────────────────

function scanReversed(text: string, patterns: PatternDef[]): PatternMatch[] {
  if (text.length < 20) return [];
  const reversed = [...text].reverse().join('');
  const results: PatternMatch[] = [];
  for (const def of patterns) {
    if (def.severity !== 'high') continue;
    const revMatch = def.pattern.exec(reversed);
    const origMatch = def.pattern.exec(text);
    if (revMatch && !origMatch) {
      results.push({
        pattern: `reverse:${def.label}`,
        category: def.category,
        severity: def.severity,
        matched: `[reverse] ${revMatch[0]}`,
      });
    }
  }
  return results;
}

// ── Acrostic (first char of each line) ─────────────────────

function scanAcrostic(text: string, patterns: PatternDef[]): PatternMatch[] {
  const lines = text.split('\n');
  if (lines.length < 5) return [];

  const firstChars: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    firstChars.push(trimmed[0]);
  }
  if (firstChars.length < 5) return [];

  const acrostic = firstChars.join('').toLowerCase();

  const results: PatternMatch[] = [];
  for (const def of patterns) {
    if (def.severity !== 'high') continue;
    const m = def.pattern.exec(acrostic);
    if (m) {
      results.push({
        pattern: `acrostic:${def.label}`,
        category: def.category,
        severity: def.severity,
        matched: `[acrostic] ${m[0]}`,
      });
    }
  }
  return results;
}

export { PATTERNS, type PatternDef };
