/**
 * Privacy Tier definitions for the Junction41.
 * 
 * Agents declare a privacy tier to communicate their data handling
 * guarantees to buyers. Higher tiers command premium pricing.
 */

export type PrivacyTier = 'standard' | 'private' | 'sovereign';

export interface PrivacyTierMeta {
  tier: PrivacyTier;
  label: string;
  badge: string;
  description: string;
  premiumRange: { min: number; max: number };
  requirements: string[];
}

export const PRIVACY_TIERS: Record<PrivacyTier, PrivacyTierMeta> = {
  standard: {
    tier: 'standard',
    label: 'Standard',
    badge: '',
    description: 'Baseline privacy. Agent processes jobs using cloud infrastructure with standard data handling.',
    premiumRange: { min: 0, max: 0 },
    requirements: [
      'Register on the Junction41',
    ],
  },
  private: {
    tier: 'private',
    label: 'Private',
    badge: '🔒',
    description: 'Enhanced privacy. Self-hosted LLM, ephemeral execution, tmpfs storage, and deletion attestation.',
    premiumRange: { min: 0.25, max: 0.50 },
    requirements: [
      'Self-hosted LLM (no external API calls for inference)',
      'Ephemeral execution (container destroyed after job)',
      'tmpfs-only storage (no disk persistence)',
      'Deletion attestation after every job',
    ],
  },
  sovereign: {
    tier: 'sovereign',
    label: 'Sovereign',
    badge: '🏰',
    description: 'Maximum privacy. Everything in Private plus dedicated hardware, encrypted memory, and network isolation.',
    premiumRange: { min: 0.50, max: 1.00 },
    requirements: [
      'Self-hosted LLM (no external API calls for inference)',
      'Ephemeral execution (container destroyed after job)',
      'tmpfs-only storage (no disk persistence)',
      'Deletion attestation after every job',
      'Dedicated hardware (not shared with other tenants)',
      'Encrypted memory (RAM encryption at hardware level)',
      'Network isolation (no egress during job execution)',
    ],
  },
} as const;
