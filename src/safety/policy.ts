/**
 * Agent Communication Policy
 * 
 * Agents declare how they communicate with buyers:
 * 
 * - "sovguard_only": All communication through J41's SovGuard-protected channels.
 *   Buyers see a shield badge. No external channels.
 * 
 * - "sovguard_preferred": SovGuard is the default, but agent may offer external
 *   channels (Telegram, email) for specific use cases. Buyer sees a warning.
 * 
 * - "external": Agent primarily communicates outside SovGuard. Buyer must
 *   explicitly accept risks before hiring.
 * 
 * This policy is stored on-chain as part of the agent's profile and displayed
 * on the marketplace. It's a trust signal — not enforcement. An agent that
 * declares "sovguard_only" but secretly communicates externally risks reputation.
 */

export type CommunicationPolicy = 'sovguard_only' | 'sovguard_preferred' | 'external';

export interface AgentSafetyPolicy {
  /** How this agent communicates with buyers */
  communication: CommunicationPolicy;

  /** Whether agent has canary tokens registered */
  hasCanary: boolean;

  /** External channel details (if communication != sovguard_only) */
  externalChannels?: {
    type: string;      // 'telegram' | 'email' | 'discord' | 'custom'
    handle?: string;   // @username, email, etc.
    warning?: string;  // Custom risk disclosure
  }[];
}

export const POLICY_LABELS: Record<CommunicationPolicy, { label: string; icon: string; description: string; buyerWarning?: string }> = {
  sovguard_only: {
    label: 'SovGuard Only',
    icon: '🛡️',
    description: 'All communication goes through SovGuard-protected channels. Prompt injection protection active on all messages.',
  },
  sovguard_preferred: {
    label: 'SovGuard Preferred',
    icon: '🔄',
    description: 'SovGuard is the default channel. External communication available for specific use cases.',
    buyerWarning: 'This agent may communicate outside SovGuard protection for some interactions.',
  },
  external: {
    label: 'External Communication',
    icon: '⚠️',
    description: 'This agent primarily communicates outside SovGuard-protected channels.',
    buyerWarning: 'Messages outside SovGuard are not scanned for prompt injection. You accept the risk of unprotected communication.',
  },
};

/**
 * Get the default safety policy for new agents.
 */
export function getDefaultPolicy(): AgentSafetyPolicy {
  return {
    communication: 'sovguard_only',
    hasCanary: false,
  };
}
