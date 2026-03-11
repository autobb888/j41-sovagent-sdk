/**
 * Validation functions matching verus-agent-platform rules.
 * Each returns null on valid, error message string on invalid.
 */

export const AGENT_NAME_REGEX = /^[a-zA-Z0-9._-]+$/;
export const RESERVED_NAMES = ['admin', 'system', 'platform', 'verus', 'test', 'root', 'api', 'www'];
export const VALID_PROTOCOLS = ['MCP', 'REST', 'A2A', 'WebSocket'] as const;
export const VALID_TYPES = ['autonomous', 'assisted', 'hybrid', 'tool'] as const;

export type ValidProtocol = typeof VALID_PROTOCOLS[number];
export type ValidAgentType = typeof VALID_TYPES[number];

export interface EndpointInput {
  url: string;
  protocol: string;
  public?: boolean;
  description?: string;
}

export interface CapabilityInput {
  id: string;
  name: string;
  description?: string;
  protocol?: string;
  endpoint?: string;
  public?: boolean;
  pricing?: { amount: number; currency: string; per?: string };
  rateLimit?: { requests: number; period: string };
}

export function validateAgentName(name: string): string | null {
  if (!name) return 'Name is required';
  if (name.length < 3) return 'Name must be at least 3 characters';
  if (name.length > 64) return 'Name must be at most 64 characters';
  if (!AGENT_NAME_REGEX.test(name)) return 'Name can only contain letters, numbers, dots, hyphens, and underscores';
  if (RESERVED_NAMES.includes(name.toLowerCase())) return `"${name}" is a reserved name`;
  return null;
}

export function validateAgentType(type: string): string | null {
  if (!type) return 'Type is required';
  if (!(VALID_TYPES as readonly string[]).includes(type)) {
    return `Type must be one of: ${VALID_TYPES.join(', ')}`;
  }
  return null;
}

export function validateDescription(desc: string): string | null {
  if (!desc) return 'Description is required';
  if (desc.length < 10) return 'Description must be at least 10 characters';
  if (desc.length > 1000) return 'Description must be at most 1000 characters';
  return null;
}

export function validateTags(tags: string[]): string | null {
  if (tags.length > 20) return 'Maximum 20 tags allowed';
  for (const tag of tags) {
    if (tag.length > 32) return `Tag "${tag}" exceeds 32 character limit`;
    if (tag.length === 0) return 'Empty tags are not allowed';
  }
  return null;
}

export function validateUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return 'URL must use http or https protocol';
    }
    return null;
  } catch {
    return 'Invalid URL format';
  }
}

export function validateProtocols(protocols: string[]): string | null {
  if (protocols.length > 10) return 'Maximum 10 protocols allowed';
  for (const p of protocols) {
    if (!(VALID_PROTOCOLS as readonly string[]).includes(p)) {
      return `Invalid protocol "${p}". Valid: ${VALID_PROTOCOLS.join(', ')}`;
    }
  }
  return null;
}

export function validateEndpoint(ep: EndpointInput): string | null {
  if (!ep.url) return 'Endpoint URL is required';
  const urlErr = validateUrl(ep.url);
  if (urlErr) return `Endpoint URL: ${urlErr}`;
  if (!ep.protocol) return 'Endpoint protocol is required';
  return null;
}

export function validateCapability(cap: CapabilityInput): string | null {
  if (!cap.id) return 'Capability ID is required';
  if (!cap.name) return 'Capability name is required';
  return null;
}

export interface SessionInput {
  duration?: number;
  tokenLimit?: number;
  imageLimit?: number;
  messageLimit?: number;
  maxFileSize?: number;
  allowedFileTypes?: string[];
}

function isFinitePositive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function isFinitePositiveInt(v: unknown): v is number {
  return isFinitePositive(v) && Number.isInteger(v);
}

export function validateSessionInput(session: SessionInput): string | null {
  if (session.duration != null && !isFinitePositive(session.duration)) {
    return 'Session duration must be a finite positive number (seconds)';
  }
  if (session.tokenLimit != null && !isFinitePositiveInt(session.tokenLimit)) {
    return 'Token limit must be a finite positive integer';
  }
  if (session.imageLimit != null && !isFinitePositiveInt(session.imageLimit)) {
    return 'Image limit must be a finite positive integer';
  }
  if (session.messageLimit != null && !isFinitePositiveInt(session.messageLimit)) {
    return 'Message limit must be a finite positive integer';
  }
  if (session.maxFileSize != null && !isFinitePositiveInt(session.maxFileSize)) {
    return 'Max file size must be a finite positive integer (bytes)';
  }
  if (session.allowedFileTypes != null) {
    if (!Array.isArray(session.allowedFileTypes)) {
      return 'Allowed file types must be an array of MIME type strings';
    }
    for (const ft of session.allowedFileTypes) {
      if (typeof ft !== 'string' || ft.trim().length === 0) {
        return 'Each allowed file type must be a non-empty string';
      }
    }
  }
  return null;
}
