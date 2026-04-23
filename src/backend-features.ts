/**
 * Backend feature-flag check. Probes /v1/version and caches the result.
 * Used by SDK clients and the dispatcher to decide whether to emit v1 or v2
 * signing formats, whether to run the canonical mirror verifier, etc.
 *
 * Per spec §Backend feature flag:
 *   Current (291ae0a):        no signing flag           → emit v1 only
 *   +1 minor:                 signing.canonical-v1      → soft-required, emit both, prefer v2
 *   +3 minor:                 + signing.v1-retired      → emit v2 only, reject v1
 */

export interface BackendVersion {
  version: string;
  commit: string;
  features: string[];
}

const _cache = new Map<string, { result: BackendVersion; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch /v1/version. Caches per apiUrl for CACHE_TTL_MS.
 * Returns null if unreachable — caller should treat as "no flags advertised."
 */
export async function fetchBackendVersion(apiUrl: string, fetchImpl: typeof fetch = fetch): Promise<BackendVersion | null> {
  const cached = _cache.get(apiUrl);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.result;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetchImpl(`${apiUrl.replace(/\/$/, '')}/v1/version`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json() as Partial<BackendVersion>;
    if (!data || typeof data !== 'object' || !Array.isArray(data.features)) return null;
    const result: BackendVersion = {
      version: data.version ?? '',
      commit: data.commit ?? '',
      features: data.features,
    };
    _cache.set(apiUrl, { result, fetchedAt: Date.now() });
    return result;
  } catch {
    return null;
  }
}

/**
 * Check whether the backend advertises a specific feature. Network errors / missing endpoint
 * are treated as "feature absent" — safe default for callers.
 */
export async function hasFeature(apiUrl: string, feature: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const v = await fetchBackendVersion(apiUrl, fetchImpl);
  return v != null && v.features.includes(feature);
}

/**
 * Required/soft-required feature check for dispatcher startup.
 * Soft-required: missing → warn, continue. Hard-required: missing → throw.
 *
 * Logs to stderr as structured JSON so operators can scrape with promtail/fluentbit.
 * Matches spec §Telemetry → deprecation-window beacon pattern.
 */
export async function checkRequiredFeatures(opts: {
  apiUrl: string;
  required?: string[];       // throws if any missing
  softRequired?: string[];   // warns if missing, continues
  operatorIAddress?: string; // for telemetry attribution
  dispatcherVersion?: string;
}): Promise<{ ok: boolean; missing: { required: string[]; softRequired: string[] } }> {
  const v = await fetchBackendVersion(opts.apiUrl);
  if (!v) {
    // Backend unreachable — emit warning but don't block startup; transient failures shouldn't brick dispatchers.
    emitFeatureWarning({
      event: 'backend.unreachable',
      apiUrl: opts.apiUrl,
      operator_iaddress: opts.operatorIAddress,
      dispatcher_version: opts.dispatcherVersion,
    });
    return { ok: true, missing: { required: [], softRequired: [] } };
  }

  const missing = {
    required: (opts.required || []).filter(f => !v.features.includes(f)),
    softRequired: (opts.softRequired || []).filter(f => !v.features.includes(f)),
  };

  for (const feat of missing.softRequired) {
    emitFeatureWarning({
      event: 'backend.missing-feature',
      feature: feat,
      severity: 'soft-required',
      backend_version: v.version,
      backend_commit: v.commit,
      operator_iaddress: opts.operatorIAddress,
      dispatcher_version: opts.dispatcherVersion,
    });
  }

  if (missing.required.length > 0) {
    for (const feat of missing.required) {
      emitFeatureWarning({
        event: 'backend.missing-feature',
        feature: feat,
        severity: 'required',
        backend_version: v.version,
        backend_commit: v.commit,
        operator_iaddress: opts.operatorIAddress,
        dispatcher_version: opts.dispatcherVersion,
      });
    }
    return { ok: false, missing };
  }

  return { ok: true, missing };
}

function emitFeatureWarning(payload: Record<string, unknown>): void {
  if (process.env.J41_SDK_METRICS === '0') return;
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', ...payload }));
}

/** Clear the feature-version cache. Mostly useful in tests. */
export function clearBackendFeatureCache(): void {
  _cache.clear();
}
