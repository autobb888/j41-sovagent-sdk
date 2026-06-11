/**
 * Deletion Attestation — cryptographic proof that job data was destroyed.
 * 
 * After completing a job, a Private or Sovereign agent signs an attestation
 * proving that all job data, containers, and volumes were deleted.
 * The attestation is submitted to the platform and publicly verifiable.
 */

import { signMessage } from '../identity/signer.js';
import { verifyMessage as verusVerifyMessage } from '../identity/signer.js';
import { canonicalize as jsonCanonicalize } from 'json-canonicalize';

/**
 * One budget-extension event over a job's life. Recorded so a buyer can see
 * what each extension request was priced against. `amountVrsc` is null when no
 * exchange rate was available at request time (the dispatcher fails closed and
 * does not auto-price). `grantedTokens` is present once the buyer approves.
 */
export interface AttestationExtension {
  estimatedTokens: number;
  amountVrsc: number | null;
  granted: boolean;
  grantedTokens?: number;
}

/**
 * Cumulative token usage for a job, signed as part of the attestation (schema
 * v2) so both buyer and seller attest to the same usage story. This is what
 * makes extension requests trustable enough to ever auto-approve.
 */
export interface AttestationTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  llmCalls: number;
  extensions: AttestationExtension[];
}

/** Schema version stamped into the payload when tokenUsage is present. */
export const ATTESTATION_SCHEMA_VERSION = 2;

export interface DeletionAttestation {
  jobId: string;
  containerId: string;
  createdAt: string;
  destroyedAt: string;
  dataVolumes: string[];
  deletionMethod: string;
  attestedBy: string;   // VerusID (e.g. myagent.agentplatform@)
  schemaVersion?: number;             // present (=2) only when tokenUsage is included
  tokenUsage?: AttestationTokenUsage; // WP-D4 #6 — usage signed over, not just sidecar'd
  signature: string;
}

export interface AttestationParams {
  jobId: string;
  containerId: string;
  createdAt: string;
  destroyedAt: string;
  dataVolumes?: string[];
  deletionMethod?: string;
  attestedBy: string;
  tokenUsage?: AttestationTokenUsage;
}

/**
 * Coerce a tokenUsage object to a clean, whitelisted shape so the signed
 * payload is deterministic and can't carry caller-injected keys. Counts are
 * forced to non-negative integers; extensions to the known fields only.
 */
function normalizeTokenUsage(u: AttestationTokenUsage): AttestationTokenUsage {
  const int = (n: unknown): number => {
    const v = Math.floor(Number(n));
    return Number.isFinite(v) && v >= 0 ? v : 0;
  };
  const extensions = Array.isArray(u.extensions) ? u.extensions.map((e) => {
    const ext: AttestationExtension = {
      estimatedTokens: int(e.estimatedTokens),
      amountVrsc: typeof e.amountVrsc === 'number' && Number.isFinite(e.amountVrsc) ? e.amountVrsc : null,
      granted: !!e.granted,
    };
    if (e.grantedTokens != null) ext.grantedTokens = int(e.grantedTokens);
    return ext;
  }) : [];
  return {
    promptTokens: int(u.promptTokens),
    completionTokens: int(u.completionTokens),
    totalTokens: int(u.totalTokens),
    llmCalls: int(u.llmCalls),
    extensions,
  };
}

/**
 * Generate the canonical JSON payload for a deletion attestation.
 * Uses sorted keys for deterministic output (json-canonicalize / JCS).
 * Returns the payload object (without signature).
 *
 * When `tokenUsage` is supplied the payload is schema v2: `tokenUsage` and
 * `schemaVersion` are added to the signed bytes (WP-D4 #6). When it's absent
 * the payload is byte-identical to the v1 shape, so existing attestations and
 * verifiers are unaffected.
 */
export function generateAttestationPayload(params: AttestationParams): Omit<DeletionAttestation, 'signature'> {
  const payload: Omit<DeletionAttestation, 'signature'> = {
    attestedBy: params.attestedBy,
    containerId: params.containerId,
    createdAt: params.createdAt,
    dataVolumes: params.dataVolumes ?? [],
    deletionMethod: params.deletionMethod ?? 'container-destroy+volume-rm',
    destroyedAt: params.destroyedAt,
    jobId: params.jobId,
  };
  if (params.tokenUsage) {
    payload.schemaVersion = ATTESTATION_SCHEMA_VERSION;
    payload.tokenUsage = normalizeTokenUsage(params.tokenUsage);
  }
  return payload;
}

/**
 * Canonical JSON string for signing.
 * Keys are sorted alphabetically for deterministic output.
 */
function canonicalize(payload: Omit<DeletionAttestation, 'signature'>): string {
  return jsonCanonicalize(payload);
}

/**
 * Sign a deletion attestation payload.
 *
 * @param payload - The attestation payload (without signature)
 * @param wif - WIF private key for signing
 * @param network - 'verus' or 'verustest' (default: 'verustest')
 * @returns Full DeletionAttestation with signature
 */
export function signAttestation(
  payload: Omit<DeletionAttestation, 'signature'>,
  wif: string,
  network: 'verus' | 'verustest' = 'verustest',
): DeletionAttestation {
  const message = canonicalize(payload);
  const signature = signMessage(wif, message, network);

  return {
    ...payload,
    signature,
  };
}

/**
 * Async variant that delegates signing to a caller-supplied function. Lets
 * `J41Agent.attestDeletion` route through a `RemoteSigner` (host-side broker)
 * instead of holding a WIF in the container. The signed bytes are the same
 * canonical-JCS string as `signAttestation`, so signatures are
 * cross-verifiable between the two paths.
 */
export async function signAttestationWith(
  payload: Omit<DeletionAttestation, 'signature'>,
  signFn: (message: string) => Promise<string>,
): Promise<DeletionAttestation> {
  const message = canonicalize(payload);
  const signature = await signFn(message);
  return { ...payload, signature };
}

/**
 * Verify that a DeletionAttestation has all required fields with correct types.
 * Does NOT verify the cryptographic signature — that requires the signer's public key.
 * 
 * @returns true if format is valid, throws with message if not
 */
export function verifyAttestationFormat(attestation: unknown): attestation is DeletionAttestation {
  if (!attestation || typeof attestation !== 'object') {
    throw new Error('Attestation must be a non-null object');
  }

  const a = attestation as Record<string, unknown>;

  const requiredStrings: Array<keyof DeletionAttestation> = [
    'jobId', 'containerId', 'createdAt', 'destroyedAt',
    'deletionMethod', 'attestedBy', 'signature',
  ];

  for (const field of requiredStrings) {
    if (typeof a[field] !== 'string' || (a[field] as string).length === 0) {
      throw new Error(`Missing or invalid field: ${field} (expected non-empty string)`);
    }
  }

  if (!Array.isArray(a.dataVolumes)) {
    throw new Error('Missing or invalid field: dataVolumes (expected string array)');
  }

  for (let i = 0; i < a.dataVolumes.length; i++) {
    if (typeof a.dataVolumes[i] !== 'string') {
      throw new Error(`dataVolumes[${i}] must be a string`);
    }
  }

  // Schema v2 (WP-D4 #6): when tokenUsage is present it must be well-formed.
  // Fail closed — a malformed usage block is a rejected attestation, never
  // accepted-and-ignored (that would let a seller forge usage).
  if (a.tokenUsage !== undefined) {
    const u = a.tokenUsage as Record<string, unknown>;
    if (!u || typeof u !== 'object' || Array.isArray(u)) {
      throw new Error('tokenUsage must be an object');
    }
    for (const f of ['promptTokens', 'completionTokens', 'totalTokens', 'llmCalls'] as const) {
      if (!Number.isInteger(u[f]) || (u[f] as number) < 0) {
        throw new Error(`tokenUsage.${f} must be a non-negative integer`);
      }
    }
    if (!Array.isArray(u.extensions)) {
      throw new Error('tokenUsage.extensions must be an array');
    }
    for (let i = 0; i < u.extensions.length; i++) {
      const e = u.extensions[i] as Record<string, unknown>;
      if (!e || typeof e !== 'object') {
        throw new Error(`tokenUsage.extensions[${i}] must be an object`);
      }
      if (!Number.isInteger(e.estimatedTokens) || (e.estimatedTokens as number) < 0) {
        throw new Error(`tokenUsage.extensions[${i}].estimatedTokens must be a non-negative integer`);
      }
      if (typeof e.granted !== 'boolean') {
        throw new Error(`tokenUsage.extensions[${i}].granted must be a boolean`);
      }
      if (e.amountVrsc !== null && typeof e.amountVrsc !== 'number') {
        throw new Error(`tokenUsage.extensions[${i}].amountVrsc must be a number or null`);
      }
    }
    if (a.schemaVersion !== undefined && typeof a.schemaVersion !== 'number') {
      throw new Error('schemaVersion must be a number');
    }
  }

  return true;
}

/**
 * Verify the cryptographic signature on a DeletionAttestation against an
 * expected primary R-address. Reconstructs the canonical JCS payload (sans
 * signature), then calls verusVerifyMessage.
 *
 * Audit 2026-06-02 M-SDK-funds-2 — verifyAttestationFormat was exported
 * without this companion, making forge-by-omission easy: callers could
 * shape-check an attestation and skip the crypto. Always pair the two:
 *
 *   verifyAttestationFormat(att);
 *   verifyAttestationSignature(att, expectedRAddress);
 *
 * Returns true on a valid signature; false on a malformed payload or sig
 * mismatch. Never throws (use verifyAttestationFormat for shape errors).
 */
export function verifyAttestationSignature(
  attestation: DeletionAttestation,
  expectedAddress: string,
): boolean {
  try {
    const { signature, ...payload } = attestation;
    const message = canonicalize(payload);
    return verusVerifyMessage(message, expectedAddress, signature);
  } catch {
    return false;
  }
}
