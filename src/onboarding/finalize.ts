import fs from 'fs';
import path from 'path';
import readline from 'readline';
import type { J41Agent } from '../agent.js';
import type { EndpointInput, CapabilityInput, SessionInput } from './validation.js';
import {
  validateAgentName,
  validateAgentType,
  validateDescription,
  validateTags,
  validateUrl,
  validateProtocols,
  validateSessionInput,
  VALID_PROTOCOLS,
  VALID_TYPES,
} from './validation.js';

export type { EndpointInput, CapabilityInput, SessionInput } from './validation.js';

export type FinalizeMode = 'headless' | 'interactive';

export type FinalizeStage =
  | 'onboarded'
  | 'vdxf_published'
  | 'vdxf_verified'
  | 'indexed'
  | 'profile_registered'
  | 'services_registered'
  | 'ready';

export interface FinalizeState {
  agentId?: string;
  identity?: string | null;
  iAddress?: string | null;
  mode: FinalizeMode;
  stage: FinalizeStage;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  notes?: string[];
}

export interface DataPolicyInput {
  retention?: 'ephemeral' | 'session' | 'persistent';
  allowTraining?: boolean;
  allowThirdParty?: boolean;
  requireDeletion?: boolean;
}

/** agent.network JSON blob */
export interface NetworkInput {
  capabilities?: string[];
  endpoints?: string[];
  protocols?: string[];
}

/** agent.profile JSON blob */
export interface ProfileInput {
  tags?: string[];
  website?: string;
  avatar?: string;
  category?: string;
}

/** platform.config JSON blob */
export interface PlatformConfigInput {
  datapolicy?: string | DataPolicyInput;
  trustlevel?: string;
  disputeresolution?: string;
}

/** workspace.capability JSON blob */
export interface WorkspaceCapabilityInput {
  workspace: boolean;
  modes: ('supervised' | 'standard')[];
  tools: string[];
}

/** job.record JSON blob */
export interface JobRecordInput {
  jobHash: string;
  buyer: string;
  description?: string;
  amount: number;
  currency: string;
  completedAt: number;
  completionSignature: string;
  paymentTxid?: string;
  hasWorkspace?: boolean;
  hasReview?: boolean;
}

/** review.record JSON blob */
export interface ReviewRecordInput {
  buyer: string;
  jobHash: string;
  message: string;
  rating: number;
  signature: string;
  timestamp: number;
}

/** workspace.attestation JSON blob */
export interface WorkspaceAttestationInput {
  jobId: string;
  buyer: string;
  duration: number;
  filesRead: number;
  filesWritten: number;
  sovguardFlags: number;
  completedClean: boolean;
  mode: 'supervised' | 'standard';
  platformSignature?: string;
}

export interface AgentProfileInput {
  name: string;
  type: 'autonomous' | 'assisted' | 'hybrid' | 'tool';
  description: string;
  owner?: string;
  /** Consolidated network blob → agent.network */
  network?: NetworkInput;
  /** Consolidated profile blob → agent.profile */
  profile?: ProfileInput;
  session?: SessionInput;
  /** Consolidated platform config → platform.config */
  platformConfig?: PlatformConfigInput;
  /** Workspace capability declaration → workspace.capability */
  workspaceCapability?: WorkspaceCapabilityInput;
}

export interface ServiceInput {
  name: string;
  description?: string;
  category?: string;
  price?: number;
  currency?: string;
  turnaround?: string;
  paymentTerms?: 'prepay' | 'postpay' | 'split';
  privateMode?: boolean;
  sovguard?: boolean;
  acceptedCurrencies?: Array<{ currency: string; price: number }>;
  resolutionWindow?: number;
  refundPolicy?: { policy: 'fixed' | 'negotiable' | 'none'; percent?: number };
  status?: string;
}

export interface FinalizeHooks {
  publishVdxf?: () => Promise<void>;
  verifyVdxf?: () => Promise<void>;
  waitForIndexed?: () => Promise<void>;
  prompt?: (question: string, defaultValue?: string) => Promise<string>;
}

export interface FinalizeOnboardingParams {
  agent: J41Agent;
  statePath: string;
  mode?: FinalizeMode;
  profile?: AgentProfileInput;
  services?: ServiceInput[];
  hooks?: FinalizeHooks;
}

function nowIso(): string {
  return new Date().toISOString();
}

const VALID_STAGES: FinalizeStage[] = [
  'onboarded', 'vdxf_published', 'vdxf_verified', 'indexed',
  'profile_registered', 'services_registered', 'ready',
];

function readState(statePath: string, mode: FinalizeMode, identity?: string | null, iAddress?: string | null): FinalizeState {
  if (fs.existsSync(statePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as FinalizeState;
      // Validate that the state has a recognized stage to prevent proceeding on corrupted data
      if (!parsed.stage || !VALID_STAGES.includes(parsed.stage)) {
        console.warn(`[Finalize] Invalid stage "${parsed.stage}" in ${statePath}, starting fresh`);
      } else {
        return parsed;
      }
    } catch {
      console.warn(`[Finalize] Corrupt state file ${statePath}, starting fresh`);
    }
  }

  return {
    mode,
    stage: 'onboarded',
    identity: identity || null,
    iAddress: iAddress || null,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    notes: [],
  };
}

function writeState(statePath: string, state: FinalizeState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  state.updatedAt = nowIso();
  // Atomic write: write to temp file then rename to prevent corruption on crash
  const tmp = statePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
}

async function defaultPrompt(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const q = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
  const answer = await new Promise<string>((resolve) => rl.question(q, resolve));
  rl.close();
  return answer.trim() || (defaultValue || '');
}

async function resolveProfile(mode: FinalizeMode, profile: AgentProfileInput | undefined, hooks?: FinalizeHooks): Promise<AgentProfileInput | undefined> {
  if (profile) return profile;
  if (mode !== 'interactive') return undefined;

  const prompt = hooks?.prompt || defaultPrompt;

  // Required fields
  const name = await prompt('Agent name (3-64 chars, letters/numbers/._-)');
  const nameErr = validateAgentName(name);
  if (nameErr) throw new Error(nameErr);

  const typeRaw = await prompt(`Agent type (${VALID_TYPES.join('|')})`, 'autonomous');
  const typeErr = validateAgentType(typeRaw);
  if (typeErr) throw new Error(typeErr);
  const type = typeRaw as AgentProfileInput['type'];

  const description = await prompt('Description (10-1000 chars)');
  const descErr = validateDescription(description);
  if (descErr) throw new Error(descErr);

  // Optional fields
  const category = await prompt('Category (optional)', 'general');
  const owner = await prompt('Owner VerusID (optional)');
  const tagsRaw = await prompt('Tags (comma-separated, max 20, optional)');
  const website = await prompt('Website URL (optional)');
  const avatar = await prompt('Avatar image URL (optional)');
  const protocolsRaw = await prompt(`Protocols (comma-separated: ${VALID_PROTOCOLS.join(',')}) (optional)`);

  // Parse tags
  let tags: string[] | undefined;
  if (tagsRaw) {
    tags = tagsRaw.split(',').map(t => t.trim()).filter(Boolean);
    const tagsErr = validateTags(tags);
    if (tagsErr) throw new Error(tagsErr);
  }

  // Validate website
  if (website) {
    const urlErr = validateUrl(website);
    if (urlErr) throw new Error(`Website: ${urlErr}`);
  }

  // Validate avatar
  if (avatar) {
    const urlErr = validateUrl(avatar);
    if (urlErr) throw new Error(`Avatar: ${urlErr}`);
  }

  // Parse protocols
  let protocols: string[] | undefined;
  if (protocolsRaw) {
    const parsed = protocolsRaw.split(',').map(p => p.trim()).filter(Boolean);
    const protErr = validateProtocols(parsed);
    if (protErr) throw new Error(protErr);
    protocols = parsed;
  }

  // Endpoints (interactive loop)
  const endpoints: EndpointInput[] = [];
  let addEndpoint = (await prompt('Add an endpoint? (y/N)', 'N')).toLowerCase();
  while (addEndpoint === 'y' || addEndpoint === 'yes') {
    const url = await prompt('  Endpoint URL');
    const protocol = await prompt('  Protocol (MCP|REST|A2A|WebSocket)');
    const desc = await prompt('  Description (optional)');
    const pubRaw = await prompt('  Public? (y/N)', 'N');
    endpoints.push({
      url,
      protocol,
      description: desc || undefined,
      public: pubRaw.toLowerCase() === 'y' || pubRaw.toLowerCase() === 'yes',
    });
    if (endpoints.length >= 10) break;
    addEndpoint = (await prompt('Add another endpoint? (y/N)', 'N')).toLowerCase();
  }

  // Capabilities (interactive loop)
  const capabilities: CapabilityInput[] = [];
  let addCap = (await prompt('Add a capability? (y/N)', 'N')).toLowerCase();
  while (addCap === 'y' || addCap === 'yes') {
    const capId = await prompt('  Capability ID');
    const capName = await prompt('  Capability name');
    const capDesc = await prompt('  Description (optional)');
    capabilities.push({
      id: capId,
      name: capName,
      description: capDesc || undefined,
    });
    if (capabilities.length >= 50) break;
    addCap = (await prompt('Add another capability? (y/N)', 'N')).toLowerCase();
  }

  // Session limits (optional)
  const addSession = (await prompt('Configure session limits? (y/N)', 'N')).toLowerCase();
  let session: SessionInput | undefined;
  if (addSession === 'y' || addSession === 'yes') {
    const durationRaw = await prompt('  Session duration in seconds (optional)');
    const tokenLimitRaw = await prompt('  Token limit per session (optional)');
    const imageLimitRaw = await prompt('  Image limit per session (optional)');
    const messageLimitRaw = await prompt('  Message limit per session (optional)');
    const maxFileSizeRaw = await prompt('  Max file size in bytes (optional)');
    const allowedFileTypesRaw = await prompt('  Allowed file types (comma-separated MIME types, optional)');

    const s: SessionInput = {};
    if (durationRaw) {
      const n = Number(durationRaw);
      if (Number.isFinite(n) && n > 0) s.duration = n;
    }
    if (tokenLimitRaw) {
      const n = Number(tokenLimitRaw);
      if (Number.isFinite(n) && n > 0 && Number.isInteger(n)) s.tokenLimit = n;
    }
    if (imageLimitRaw) {
      const n = Number(imageLimitRaw);
      if (Number.isFinite(n) && n > 0 && Number.isInteger(n)) s.imageLimit = n;
    }
    if (messageLimitRaw) {
      const n = Number(messageLimitRaw);
      if (Number.isFinite(n) && n > 0 && Number.isInteger(n)) s.messageLimit = n;
    }
    if (maxFileSizeRaw) {
      const n = Number(maxFileSizeRaw);
      if (Number.isFinite(n) && n > 0 && Number.isInteger(n)) s.maxFileSize = n;
    }
    if (allowedFileTypesRaw) {
      const types = allowedFileTypesRaw.split(',').map(t => t.trim()).filter(Boolean);
      if (types.length > 0) s.allowedFileTypes = types;
    }

    if (Object.keys(s).length > 0) {
      const sessionErr = validateSessionInput(s);
      if (sessionErr) throw new Error(sessionErr);
      session = s;
    }
  }

  const result: AgentProfileInput = { name, type, description };
  if (owner) result.owner = owner;

  // Consolidated network blob
  const network: NetworkInput = {};
  if (capabilities.length) network.capabilities = capabilities.map(c => c.id || c.name);
  if (endpoints.length) network.endpoints = endpoints.map(e => e.url);
  if (protocols?.length) network.protocols = protocols as string[];
  if (Object.keys(network).length > 0) result.network = network;

  // Consolidated profile blob
  const profileBlob: ProfileInput = {};
  if (category) profileBlob.category = category;
  if (tags?.length) profileBlob.tags = tags;
  if (website) profileBlob.website = website;
  if (avatar) profileBlob.avatar = avatar;
  if (Object.keys(profileBlob).length > 0) result.profile = profileBlob;

  if (session) result.session = session;

  return result;
}

async function resolveServices(mode: FinalizeMode, services: ServiceInput[] | undefined, hooks?: FinalizeHooks): Promise<ServiceInput[]> {
  if (services && services.length) return services;
  if (mode !== 'interactive') return [];

  const prompt = hooks?.prompt || defaultPrompt;
  const result: ServiceInput[] = [];

  let add = (await prompt('Add a service now? (y/N)', 'N')).toLowerCase();
  while (add === 'y' || add === 'yes') {
    const name = await prompt('  Service name');
    if (!name) {
      console.log('  Service name is required, skipping.');
      break;
    }
    const description = await prompt('  Service description (optional)', '');
    const category = await prompt('  Service category (optional)', 'general');
    const priceRaw = await prompt('  Price in satoshis (optional)', '0');
    const currency = await prompt('  Currency (optional)', 'VRSCTEST');
    const turnaround = await prompt('  Turnaround time (optional, e.g. "24h", "instant")', 'TBD');

    result.push({
      name,
      description: description || undefined,
      category: category || undefined,
      price: Number(priceRaw) || 0,
      currency: currency || undefined,
      turnaround: turnaround || undefined,
    });

    add = (await prompt('Add another service? (y/N)', 'N')).toLowerCase();
  }

  return result;
}

export async function finalizeOnboarding(params: FinalizeOnboardingParams): Promise<FinalizeState> {
  const mode: FinalizeMode = params.mode || 'headless';
  const state = readState(params.statePath, mode, params.agent.identity, params.agent.address);

  const mark = (stage: FinalizeStage, note?: string) => {
    state.stage = stage;
    if (note) state.notes = [...(state.notes || []), `${nowIso()} ${note}`];
    writeState(params.statePath, state);
  };

  // 1) VDXF publish
  if (['onboarded'].includes(state.stage)) {
    if (params.hooks?.publishVdxf) {
      await params.hooks.publishVdxf();
      mark('vdxf_published', 'VDXF definitions published');
    } else {
      mark('vdxf_published', 'VDXF publish hook not provided (deferred)');
    }
  }

  // 2) VDXF verify
  if (['vdxf_published'].includes(state.stage)) {
    if (params.hooks?.verifyVdxf) {
      await params.hooks.verifyVdxf();
      mark('vdxf_verified', 'VDXF definitions verified');
    } else {
      mark('vdxf_verified', 'VDXF verify hook not provided (deferred)');
    }
  }

  // 3) Index sync
  if (['vdxf_verified'].includes(state.stage)) {
    if (params.hooks?.waitForIndexed) {
      await params.hooks.waitForIndexed();
      mark('indexed', 'Index visibility confirmed');
    } else {
      mark('indexed', 'Index wait hook not provided (deferred)');
    }
  }

  // 4) Platform profile registration
  if (['indexed'].includes(state.stage)) {
    const profile = await resolveProfile(mode, params.profile, params.hooks);
    if (profile) {
      await params.agent.registerWithJ41(profile);
      mark('profile_registered', 'Agent profile registered');
    } else {
      mark('profile_registered', 'Profile registration skipped');
    }
  }

  // 5) Service registration (optional by design)
  if (['profile_registered'].includes(state.stage)) {
    const services = await resolveServices(mode, params.services, params.hooks);
    for (const svc of services) {
      await params.agent.registerService(svc);
    }
    mark('services_registered', services.length ? `Registered ${services.length} service(s)` : 'No services registered');
  }

  if (state.stage === 'services_registered') {
    state.completedAt = nowIso();
    mark('ready', 'Finalize complete');
  }

  return state;
}
