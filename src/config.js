import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

function getRequired(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value.trim();
}

function getString(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === null || value.trim() === "") {
    return fallback;
  }

  return value.trim();
}

export function getNumber(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === null || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a valid number.`);
  }

  return parsed;
}

export function getBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === null || value.trim() === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function getOptional(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    return null;
  }

  return value.trim();
}

const intervalMinutes = getNumber("BOT_INTERVAL_MINUTES", 15);

export const config = {
  dmarket: {
    baseUrl: getString("DMARKET_BASE_URL", "https://api.dmarket.com"),
    apiKey: getRequired("DMARKET_API_KEY"),
    secretKey: getRequired("DMARKET_SECRET_KEY"),
    authorization: getOptional("DMARKET_AUTHORIZATION"),
    requestTimeoutMs: getNumber("DMARKET_REQUEST_TIMEOUT_MS", 20_000),
    maxRetries: getNumber("DMARKET_MAX_RETRIES", 3),
    // Balance endpoint returns coins (cents for USD, dimoshi for DMC)
    priceInCoins: getBoolean("DMARKET_PRICE_IN_COINS", true),
    // Aggregated prices are usually already in USD units
    aggregatedPricesInCoins: getBoolean(
      "DMARKET_AGGREGATED_PRICES_IN_COINS",
      false,
    ),
  },
  bot: {
    intervalMinutes,
    intervalMs: intervalMinutes * 60_000,
    gameId: getString("DMARKET_GAME_ID", "a8db"),
    currency: getString("DMARKET_CURRENCY", "USD"),
    statePath: path.resolve(
      process.cwd(),
      getString("BOT_STATE_PATH", "data/managed-targets.json"),
    ),
    dryRun: getBoolean("BOT_DRY_RUN", false),
    analysisOutputPath: path.resolve(
      process.cwd(),
      getString("ANALYSIS_OUTPUT_PATH", "data/opportunities-report.txt"),
    ),
    analysisMinTargetPriceUsd: getNumber("ANALYSIS_MIN_TARGET_PRICE_USD", 30),
    analysisMinMonthlySales: getNumber("ANALYSIS_MIN_MONTHLY_SALES", 10),
    analysisSalesConcurrency: getNumber("ANALYSIS_SALES_CONCURRENCY", 5),
  },
  strategy: {
    // Marketplace scan controls
    scanPages: getNumber("STRATEGY_SCAN_PAGES", 5),
    pageSize: getNumber("STRATEGY_PAGE_SIZE", 100),
    aggregateChunkSize: getNumber("STRATEGY_AGGREGATE_CHUNK_SIZE", 60),

    // Profitability filters
    saleCommissionPct: getNumber("STRATEGY_SALE_COMMISSION_PCT", 2),
    quickSaleDiscountPct: getNumber("STRATEGY_QUICK_SALE_DISCOUNT_PCT", 0.5),
    minProfitUsd: getNumber("STRATEGY_MIN_PROFIT_USD", 0.08),
    minRoiPct: getNumber("STRATEGY_MIN_ROI_PCT", 2.5),
    minSpreadUsd: getNumber("STRATEGY_MIN_SPREAD_USD", 0.05),
    bidStepUsd: getNumber("STRATEGY_BID_STEP_USD", 0.01),
    noOrderBidRatio: getNumber("STRATEGY_NO_ORDER_BID_RATIO", 0.65),

    // Liquidity controls
    minOffersCount: getNumber("STRATEGY_MIN_OFFERS_COUNT", 2),
    minOrdersCount: getNumber("STRATEGY_MIN_ORDERS_COUNT", 1),
    maxBuyPriceUsd: getNumber("STRATEGY_MAX_BUY_PRICE_USD", 40),
    minBuyPriceUsd: getNumber("STRATEGY_MIN_BUY_PRICE_USD", 0.1),

    // Portfolio controls
    maxManagedTargets: getNumber("STRATEGY_MAX_MANAGED_TARGETS", 30),
    newTargetsPerCycle: getNumber("STRATEGY_NEW_TARGETS_PER_CYCLE", 10),
    maxAmountPerTarget: getNumber("STRATEGY_MAX_AMOUNT_PER_TARGET", 1),
    balanceUsageRatio: getNumber("STRATEGY_BALANCE_USAGE_RATIO", 0.8),
    maxBudgetUsd: getNumber("STRATEGY_MAX_BUDGET_USD", 250),

    // Update controls
    minPriceUpdateDeltaUsd: getNumber(
      "STRATEGY_MIN_PRICE_UPDATE_DELTA_USD",
      0.005,
    ),
  },
};
