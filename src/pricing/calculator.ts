/**
 * Pricing Calculator — deterministic price estimation for agent jobs.
 * 
 * No LLM needed. All calculations are pure math based on the pricing tables.
 * Use `estimateJobCost` for raw cost and `recommendPrice` for pricing guidance.
 */

import { LLM_COSTS, API_COSTS, CATEGORY_MARKUPS, PLATFORM_FEE, type JobCategory } from './tables.js';
import type { PrivacyTier } from '../privacy/tiers.js';

// ────────────────────────────────────────────
// Privacy Premium Multipliers
// ────────────────────────────────────────────

const PRIVACY_MULTIPLIERS: Record<PrivacyTier, number> = {
  standard: 1.0,
  private: 1.33,
  sovereign: 1.83,
};

/**
 * Apply privacy tier premium to a base price.
 * 
 * @param basePrice - Base price in USD
 * @param tier - Privacy tier
 * @returns Adjusted price with privacy premium
 */
export function privacyPremium(basePrice: number, tier: PrivacyTier): number {
  return basePrice * (PRIVACY_MULTIPLIERS[tier] ?? 1.0);
}

// ────────────────────────────────────────────
// Cost Estimation
// ────────────────────────────────────────────

export interface AdditionalApiCost {
  api: string;
  count: number;
}

/**
 * Estimate the raw cost of a job based on model usage and API calls.
 * Returns cost in USD.
 * 
 * @param model - Model name (must match LLM_COSTS table)
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 * @param additionalApis - Optional additional API costs
 * @returns Raw cost in USD
 */
export function estimateJobCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  additionalApis?: AdditionalApiCost[],
): number {
  // Validate token counts
  if (!Number.isFinite(inputTokens) || inputTokens < 0) {
    throw new Error(`inputTokens must be a non-negative finite number, got: ${inputTokens}`);
  }
  if (!Number.isFinite(outputTokens) || outputTokens < 0) {
    throw new Error(`outputTokens must be a non-negative finite number, got: ${outputTokens}`);
  }

  // Find model in cost table
  const modelCost = LLM_COSTS.find(m => m.model === model);
  if (!modelCost) {
    throw new Error(`Unknown model: ${model}. Available: ${LLM_COSTS.map(m => m.model).join(', ')}`);
  }

  // LLM cost
  const llmCost = (inputTokens / 1000) * modelCost.inputPer1k
                 + (outputTokens / 1000) * modelCost.outputPer1k;

  // API costs
  let apiCost = 0;
  if (additionalApis) {
    for (const { api, count } of additionalApis) {
      if (!Number.isFinite(count) || count < 0) {
        throw new Error(`API call count for "${api}" must be a non-negative finite number, got: ${count}`);
      }
      const apiEntry = API_COSTS.find(a => a.api === api);
      if (apiEntry) {
        apiCost += apiEntry.costPerRequest * count;
      }
    }
  }

  return llmCost + apiCost;
}

// ────────────────────────────────────────────
// Price Recommendation
// ────────────────────────────────────────────

export interface RecommendPriceParams {
  model: string;
  inputTokens: number;
  outputTokens: number;
  category: JobCategory;
  privacyTier?: PrivacyTier;
  vrscUsdRate?: number;
  additionalApis?: AdditionalApiCost[];
}

export interface PricePoint {
  usd: number;
  vrsc: number;
  marginPercent: number;
}

export interface PriceRecommendation {
  rawCost: number;             // USD — actual cost to run
  platformFee: number;         // USD — platform's cut
  privacyMultiplier: number;   // Multiplier applied
  minimum: PricePoint;         // Break-even + platform fee
  recommended: PricePoint;     // Sweet spot (category midpoint)
  premium: PricePoint;         // High end of category
  ceiling: PricePoint;         // Maximum reasonable price
}

/**
 * Generate pricing recommendations for a job.
 * 
 * Returns four price points (minimum, recommended, premium, ceiling)
 * in both USD and VRSC, with margin percentages.
 * 
 * @param params - Pricing parameters
 * @returns Price recommendation with multiple tiers
 */
export function recommendPrice(params: RecommendPriceParams): PriceRecommendation {
  const {
    model,
    inputTokens,
    outputTokens,
    category,
    privacyTier = 'standard',
    vrscUsdRate = 1.0,
    additionalApis,
  } = params;

  // Validate VRSC/USD rate
  if (vrscUsdRate <= 0 || !Number.isFinite(vrscUsdRate)) {
    throw new Error(`vrscUsdRate must be a finite positive number, got: ${vrscUsdRate}`);
  }

  // Calculate raw cost
  const rawCost = estimateJobCost(model, inputTokens, outputTokens, additionalApis);

  // Apply privacy premium to base cost
  const adjustedCost = privacyPremium(rawCost, privacyTier);
  const multiplier = PRIVACY_MULTIPLIERS[privacyTier] ?? 1.0;

  // Get markup range for category
  const markup = CATEGORY_MARKUPS[category];
  if (!markup) {
    throw new Error(`Unknown category: ${category}. Available: ${Object.keys(CATEGORY_MARKUPS).join(', ')}`);
  }

  // Calculate price points
  // Minimum: seller needs adjustedCost after platform deducts PLATFORM_FEE from listed price
  // If listed = adjustedCost / (1 - fee), seller receives listed * (1 - fee) = adjustedCost
  if (PLATFORM_FEE >= 1) {
    throw new Error('PLATFORM_FEE must be less than 1 (100%)');
  }
  const minUsd = adjustedCost / (1 - PLATFORM_FEE);
  // Recommended: midpoint of category markup
  const midMarkup = (markup.min + markup.max) / 2;
  const recUsd = adjustedCost * midMarkup;
  // Premium: high end of category
  const premUsd = adjustedCost * markup.max;
  // Ceiling: 1.5x the premium (absolute max reasonable)
  const ceilUsd = premUsd * 1.5;

  const makePricePoint = (usd: number): PricePoint => ({
    usd: round(usd, 6),
    vrsc: round(usd / vrscUsdRate, 6),
    marginPercent: adjustedCost > 0 ? round(((usd - adjustedCost) / adjustedCost) * 100, 1) : 0,
  });

  return {
    rawCost: round(rawCost, 6),
    platformFee: round(adjustedCost * PLATFORM_FEE, 6),
    privacyMultiplier: multiplier,
    minimum: makePricePoint(minUsd),
    recommended: makePricePoint(recUsd),
    premium: makePricePoint(premUsd),
    ceiling: makePricePoint(ceilUsd),
  };
}

// ────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────

function round(n: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}
