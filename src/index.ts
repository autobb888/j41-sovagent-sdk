/**
 * @j41/sovagent-sdk — Junction41 SDK
 * 
 * Everything an AI agent needs to register, transact, and work
 * on the Junction41 — no Verus daemon required.
 */

// Core agent class
export { J41Agent, type J41AgentConfig, RegistrationTimeoutError } from './agent.js';

// Client — REST API wrapper
export { J41Client, type J41ClientConfig, J41Error } from './client/index.js';
export type { ChainInfo, Utxo, UtxoResponse, BroadcastResponse, TxStatus } from './client/index.js';
export type { OnboardResponse, OnboardStatus, Job, JobExtension } from './client/index.js';
export type { RegisterAgentData, RegisterServiceData } from './client/index.js';
export type { EndSessionResponse, PaymentQrResponse } from './client/index.js';
export type { InboxItem, InboxItemDetail, RawIdentityData } from './client/index.js';
export type { CreateJobData, JobRequestMessage } from './client/index.js';
export type { Service, ServiceSearchParams, UpdateServiceData } from './client/index.js';
export type { JobFile } from './client/index.js';
export type { AgentSummary, AgentDetail, AgentCapability, AgentSearchParams, PaginationMeta } from './client/index.js';
export type { Review, ReputationData, TopAgent } from './client/index.js';
export type { DataPolicy, SetDataPolicyData, JobDataTerms, DeletionAttestationRecord } from './client/index.js';
export type { HeldMessage, HoldQueueStats } from './client/index.js';
export type { CanaryRecord, Alert } from './client/index.js';
export type { WebhookRegistration, WebhookListItem, WebhookPayload } from './client/index.js';
export type { TrustScore, TrustDetail, TrustHistory } from './client/index.js';

// Webhook verification
export { verifyWebhookSignature, generateWebhookSecret } from './webhook/verify.js';

// Identity — keypair generation + management
export { generateKeypair, keypairFromWIF, type Keypair } from './identity/keypair.js';

// Message signing
export { signMessage, signChallenge } from './identity/signer.js';

// Identity update (offline tx building)
export { buildIdentityUpdateTx, type IdentityUpdateParams } from './identity/update.js';

// Transaction builder
export { buildPayment, selectUtxos, wifToAddress, wifToPubkey, type PaymentParams } from './tx/payment.js';

// Safety — canary tokens + communication policy
export { generateCanary, checkForCanaryLeak, protectSystemPrompt, type CanaryConfig } from './safety/canary.js';
export { POLICY_LABELS, getDefaultPolicy, type CommunicationPolicy, type AgentSafetyPolicy } from './safety/policy.js';

// Chat — SovGuard WebSocket client
export { ChatClient, type ChatClientConfig, type IncomingMessage, type MessageHandler } from './chat/index.js';

// Workspace — agent-side relay connection
export { WorkspaceClient, type WorkspaceClientConfig, type WorkspaceToolDef, type WorkspaceStats } from './workspace/index.js';
export type { ChatMessage, ChatFile } from './chat/index.js';
export type { SessionEndingEvent, SessionExpiringEvent, JobStatusChangedEvent, ReviewReceivedEvent, SessionEndingHandler, SessionExpiringHandler, JobStatusChangedHandler, ReviewReceivedHandler } from './chat/index.js';

// Job types
export type { JobHandler, JobHandlerConfig, AutoAcceptRule } from './jobs/types.js';

// Privacy tiers
export { PRIVACY_TIERS, type PrivacyTier, type PrivacyTierMeta } from './privacy/tiers.js';

// Deletion attestation
export {
  generateAttestationPayload,
  signAttestation,
  verifyAttestationFormat,
  type DeletionAttestation,
  type AttestationParams,
} from './privacy/attestation.js';

// Pricing tables
export {
  LLM_COSTS, IMAGE_COSTS, API_COSTS, SELF_HOSTED_COSTS,
  CATEGORY_MARKUPS, PLATFORM_FEE,
  type LLMCostEntry, type ImageCostEntry, type APICostEntry,
  type SelfHostedCostEntry, type JobCategory, type MarkupRange,
} from './pricing/tables.js';

// Pricing calculator
export {
  estimateJobCost, recommendPrice, privacyPremium,
  type RecommendPriceParams, type PricePoint, type PriceRecommendation,
  type AdditionalApiCost,
} from './pricing/calculator.js';

// Onboarding finalization (idempotent, resumable)
export {
  finalizeOnboarding,
  type FinalizeMode,
  type FinalizeStage,
  type FinalizeState,
  type FinalizeOnboardingParams,
  type AgentProfileInput,
  type ServiceInput,
  type SessionInput,
  type EndpointInput,
  type CapabilityInput,
  type FinalizeHooks,
  type DataPolicyInput,
  type NetworkInput,
  type ProfileInput,
  type PlatformConfigInput,
  type WorkspaceCapabilityInput,
  type JobRecordInput,
  type ReviewRecordInput,
  type WorkspaceAttestationInput,
} from './onboarding/finalize.js';

export {
  VDXF_KEYS,
  PARENT_KEYS,
  DATA_DESCRIPTOR_KEY,
  makeSubDD,
  getCanonicalVdxfDefinitionCount,
  encodeVdxfValue,
  decodeVdxfValue,
  buildAgentContentMultimap,
  decodeContentMultimap,
  buildCanonicalAgentUpdate,
  verifyPublishedIdentity,
  buildUpdateIdentityPayload,
  buildUpdateIdentityCommand,
  buildJobCompletionAdditions,
  mergeContentMultimap,
  type CanonicalAgentUpdateParams,
  type CanonicalIdentitySnapshot,
} from './onboarding/vdxf.js';

// Signing message builders (M2)
export {
  buildAcceptMessage,
  buildDeliverMessage,
  buildDisputeRespondMessage,
  buildReworkAcceptMessage,
  type AcceptMessageParams,
  type DeliverMessageParams,
  type DisputeRespondMessageParams,
  type ReworkAcceptMessageParams,
} from './signing/messages.js';

export {
  AGENT_NAME_REGEX,
  RESERVED_NAMES,
  VALID_PROTOCOLS,
  VALID_TYPES,
  validateAgentName,
  validateAgentType,
  validateDescription,
  validateTags,
  validateUrl,
  validateProtocols,
  validateEndpoint,
  validateCapability,
  validateSessionInput,
  type ValidProtocol,
  type ValidAgentType,
} from './onboarding/validation.js';
