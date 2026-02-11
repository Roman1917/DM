import { config } from "./config.js";
import { DMarketClient } from "./dmarketClient.js";
import { logger } from "./logger.js";
import { StateStore } from "./stateStore.js";
import {
  buildOpportunities,
  parseTargetPriceUsd,
  planManagedUpdates,
  planNewTargets,
} from "./strategy.js";
import {
  chunkArray,
  parseNumber,
  roundUsd,
  toUsd,
} from "./utils.js";

export function parseBalanceUsd(balance, priceInCoins) {
  const rawValue =
    balance?.usd ??
    balance?.USD ??
    balance?.balance?.usd ??
    balance?.Balance?.USD ??
    null;

  return toUsd(rawValue, priceInCoins) || 0;
}

function toTargetPayload({ title, amount, priceUsd, currency }) {
  return {
    Amount: `${amount}`,
    Title: title,
    Price: {
      Currency: currency,
      Amount: roundUsd(priceUsd),
    },
  };
}

function normalizeUnixTimestamp(value) {
  if (typeof value === "string" && Number.isNaN(Number(value))) {
    const parsedDateMs = Date.parse(value);
    if (Number.isFinite(parsedDateMs) && parsedDateMs > 0) {
      return Math.floor(parsedDateMs / 1000);
    }
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  // API may return seconds or milliseconds depending on endpoint version.
  if (parsed > 1_000_000_000_000) {
    return Math.floor(parsed / 1000);
  }

  return Math.floor(parsed);
}

function extractTimestampFromUnknownValue(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "number" || typeof value === "string") {
    return normalizeUnixTimestamp(value);
  }

  if (typeof value === "object") {
    const nestedCandidates = [
      value.seconds,
      value.Seconds,
      value.timestamp,
      value.Timestamp,
      value.time,
      value.Time,
      value.date,
      value.Date,
    ];
    for (const candidate of nestedCandidates) {
      const normalized = extractTimestampFromUnknownValue(candidate);
      if (normalized !== null) {
        return normalized;
      }
    }
  }

  return null;
}

function extractSaleTimestamp(sale) {
  if (!sale || typeof sale !== "object") {
    return null;
  }

  const directCandidates = [
    sale.date,
    sale.Date,
    sale.createdAt,
    sale.CreatedAt,
    sale.created_at,
    sale.timestamp,
    sale.Timestamp,
    sale.time,
    sale.Time,
    sale.ts,
    sale.TS,
  ];
  for (const candidate of directCandidates) {
    const normalized = extractTimestampFromUnknownValue(candidate);
    if (normalized !== null) {
      return normalized;
    }
  }

  for (const [key, value] of Object.entries(sale)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.includes("date") || normalizedKey.includes("time")) {
      const normalized = extractTimestampFromUnknownValue(value);
      if (normalized !== null) {
        return normalized;
      }
    }
  }

  return null;
}

function extractSalesArray(response) {
  if (!response) {
    return [];
  }

  if (Array.isArray(response)) {
    return response;
  }

  const directCandidates = [
    response.sales,
    response.Sales,
    response.items,
    response.Items,
    response.objects,
    response.Objects,
    response.data?.sales,
    response.data?.Sales,
    response.data?.items,
    response.data?.Items,
    response.result?.sales,
    response.result?.Sales,
  ];

  for (const candidate of directCandidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  if (response.sales && typeof response.sales === "object") {
    const grouped = [];
    for (const value of Object.values(response.sales)) {
      if (Array.isArray(value)) {
        grouped.push(...value);
      }
    }
    if (grouped.length > 0) {
      return grouped;
    }
  }

  return [];
}

function extractTargetOrdersArray(response) {
  if (!response) {
    return [];
  }

  if (Array.isArray(response)) {
    return response;
  }

  const directCandidates = [
    response.orders,
    response.Orders,
    response.items,
    response.Items,
    response.data?.orders,
    response.data?.Orders,
    response.result?.orders,
    response.result?.Orders,
  ];

  for (const candidate of directCandidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function normalizeAttributeKey(key) {
  return String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeAttributesObject(attributes) {
  if (!attributes) {
    return {};
  }

  if (Array.isArray(attributes)) {
    const out = {};
    for (const entry of attributes) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const key = normalizeAttributeKey(
        entry.name ?? entry.Name ?? entry.key ?? entry.Key,
      );
      if (!key) {
        continue;
      }
      out[key] = entry.value ?? entry.Value ?? entry.val ?? "";
    }
    return out;
  }

  if (typeof attributes === "object") {
    const out = {};
    for (const [rawKey, value] of Object.entries(attributes)) {
      const key = normalizeAttributeKey(rawKey);
      if (!key) {
        continue;
      }
      out[key] = value;
    }
    return out;
  }

  return {};
}

function normalizeAttributeValue(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim().toLowerCase();
}

function readAttributeValue(attributes, keys) {
  for (const key of keys) {
    if (key in attributes) {
      return normalizeAttributeValue(attributes[key]);
    }
  }

  return "";
}

function isDefaultAnyTargetOrder(order) {
  const attributes = normalizeAttributesObject(
    order?.attributes ?? order?.Attributes,
  );
  const keys = Object.keys(attributes);
  if (keys.length === 0) {
    return false;
  }

  const phase = readAttributeValue(attributes, ["phase"]);
  const paintSeed = readAttributeValue(attributes, ["paintseed", "paint_seed"]);
  const floatPart = readAttributeValue(attributes, [
    "floatpartvalue",
    "float_part_value",
  ]);

  if (phase !== "any" || paintSeed !== "any" || floatPart !== "any") {
    return false;
  }

  const allowedKeys = new Set([
    "phase",
    "paintseed",
    "paint_seed",
    "floatpartvalue",
    "float_part_value",
  ]);
  for (const key of keys) {
    if (!allowedKeys.has(key)) {
      return false;
    }
  }

  return true;
}

function extractOrderPriceUsd(order, priceInCoins) {
  const directPrice = order?.price ?? order?.Price;
  const nestedPrice =
    order?.price?.amount ??
    order?.price?.Amount ??
    order?.Price?.amount ??
    order?.Price?.Amount;
  const raw = directPrice ?? nestedPrice ?? null;
  return toUsd(raw, priceInCoins);
}

function normalizeTargetRangeByOffer({
  minTargetUsd,
  maxTargetUsd,
  minOfferUsd,
}) {
  if (
    !Number.isFinite(maxTargetUsd) ||
    !Number.isFinite(minOfferUsd) ||
    minOfferUsd <= 0
  ) {
    return {
      minTargetUsd,
      maxTargetUsd,
      scaleAdjusted: false,
    };
  }

  const suspiciousScale =
    maxTargetUsd >= 1_000 && maxTargetUsd / minOfferUsd >= 8;
  if (!suspiciousScale) {
    return {
      minTargetUsd,
      maxTargetUsd,
      scaleAdjusted: false,
    };
  }

  return {
    minTargetUsd: Number.isFinite(minTargetUsd)
      ? roundUsd(minTargetUsd / 100)
      : minTargetUsd,
    maxTargetUsd: roundUsd(maxTargetUsd / 100),
    scaleAdjusted: true,
  };
}

export class DMarketTargetBot {
  constructor({ loggerInstance = logger } = {}) {
    this.logger = loggerInstance;
    this.client = new DMarketClient({
      config: config.dmarket,
      logger: this.logger,
    });
    this.stateStore = new StateStore(config.bot.statePath);
    this.isCycleRunning = false;
    this.isCompetitiveCycleRunning = false;
    this.isInitialized = false;
    this.intervalId = null;
  }

  async initialize() {
    if (this.isInitialized) {
      return;
    }

    await this.stateStore.load();
    this.isInitialized = true;
    this.logger.info("State loaded", {
      statePath: config.bot.statePath,
      managedTitles: this.stateStore.getManagedTitles().length,
    });
  }

  async start() {
    await this.startAutoUpdate();
  }

  async startAutoUpdate() {
    await this.initialize();
    await this.runCycleSafe();
    this.intervalId = setInterval(
      () => this.runCycleSafe(),
      config.bot.intervalMs,
    );

    this.logger.info("Auto-update mode started", {
      intervalMinutes: config.bot.intervalMinutes,
      gameId: config.bot.gameId,
      dryRun: config.bot.dryRun,
    });
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async getStatusSummary() {
    await this.initialize();
    const [balance, activeTargets] = await Promise.all([
      this.client.getBalance(),
      this.client.getAllUserTargets({ gameId: config.bot.gameId }),
    ]);

    const balanceUsd = parseBalanceUsd(balance, config.dmarket.priceInCoins);
    const managedTitles = this.stateStore.getManagedTitles();

    return {
      balanceUsd: roundUsd(balanceUsd),
      activeTargetsTotal: activeTargets.length,
      managedTargetsTotal: managedTitles.length,
      managedTitles,
      dryRun: config.bot.dryRun,
      gameId: config.bot.gameId,
      currency: config.bot.currency,
    };
  }

  async getMinOfferUsdByTitle(title) {
    const response = await this.client.getAggregatedPrices({
      titles: [title],
      limit: 1,
      offset: 0,
    });
    const rows = response?.AggregatedTitles || [];
    const exact = rows.find((row) => row?.MarketHashName === title) || rows[0];
    if (!exact) {
      return null;
    }

    const minOfferUsd = toUsd(
      exact?.Offers?.BestPrice,
      config.dmarket.aggregatedPricesInCoins,
    );
    if (!Number.isFinite(minOfferUsd) || minOfferUsd <= 0) {
      return null;
    }

    return roundUsd(minOfferUsd);
  }

  extractCreatedTargetId(createResponse) {
    const rows = createResponse?.Result;
    if (!Array.isArray(rows)) {
      return null;
    }

    for (const row of rows) {
      if (row?.Successful && row?.TargetID) {
        return row.TargetID;
      }
    }

    return null;
  }

  async createSingleTarget({ title, amount, priceUsd }) {
    const createResponse = await this.client.createTargets({
      gameId: config.bot.gameId,
      targets: [
        toTargetPayload({
          title,
          amount,
          priceUsd,
          currency: config.bot.currency,
        }),
      ],
    });

    return {
      targetId: this.extractCreatedTargetId(createResponse),
      response: createResponse,
    };
  }

  async deleteSingleTarget(targetId) {
    return this.client.deleteTargets({ targetIds: [targetId] });
  }

  async updateTargetPriceSafely({ target, newPriceUsd }) {
    const title = target.Title;
    const oldTargetId = target.TargetID;
    const oldPriceUsd = parseNumber(target?.Price?.Amount) || 0;
    const amount = Math.max(1, Math.floor(parseNumber(target?.Amount) || 1));

    if (config.bot.dryRun) {
      this.logger.info("DRY-RUN: competitive target update", {
        title,
        oldTargetId,
        oldPriceUsd,
        newPriceUsd,
      });
      return { updated: true, dryRun: true };
    }

    // Phase 1: create first, then delete old one (prevents losing target on create failure).
    try {
      const created = await this.createSingleTarget({
        title,
        amount,
        priceUsd: newPriceUsd,
      });
      if (created.targetId) {
        await this.deleteSingleTarget(oldTargetId);
        return {
          updated: true,
          strategy: "create_then_delete",
          newTargetId: created.targetId,
        };
      }
    } catch (error) {
      this.logger.warn("Create-first update failed, will try fallback", {
        title,
        oldTargetId,
        newPriceUsd,
        message: error.message,
        status: error.status,
      });
    }

    // Phase 2 fallback: delete old, create new, rollback old if create fails.
    try {
      await this.deleteSingleTarget(oldTargetId);
    } catch (error) {
      this.logger.error("Fallback failed: could not delete old target", {
        title,
        oldTargetId,
        message: error.message,
        status: error.status,
      });
      return { updated: false, reason: "delete_old_failed" };
    }

    const createdAfterDelete = await this.createSingleTarget({
      title,
      amount,
      priceUsd: newPriceUsd,
    });
    if (createdAfterDelete.targetId) {
      return {
        updated: true,
        strategy: "delete_then_create",
        newTargetId: createdAfterDelete.targetId,
      };
    }

    this.logger.error("Fallback create failed, trying rollback old target", {
      title,
      oldTargetId,
      oldPriceUsd,
    });
    const rollback = await this.createSingleTarget({
      title,
      amount,
      priceUsd: oldPriceUsd,
    });
    return {
      updated: false,
      reason: rollback.targetId ? "rollback_restored_old_target" : "rollback_failed",
    };
  }

  async runCompetitiveTargetUpdateCycleSafe() {
    if (this.isCompetitiveCycleRunning) {
      this.logger.warn(
        "Skipping competitive cycle: previous competitive cycle is still running",
      );
      return;
    }

    this.isCompetitiveCycleRunning = true;
    const startedAt = Date.now();
    try {
      await this.runCompetitiveTargetUpdateCycle();
      this.logger.info("Competitive cycle finished", {
        durationSec: roundUsd((Date.now() - startedAt) / 1000),
      });
    } catch (error) {
      this.logger.error("Competitive cycle failed", {
        message: error.message,
        stack: error.stack,
        status: error.status,
        payload: error.payload,
      });
    } finally {
      this.isCompetitiveCycleRunning = false;
    }
  }

  async runCompetitiveTargetUpdateCycle() {
    await this.initialize();
    const allTargets = await this.client.getAllUserTargets({
      gameId: config.bot.gameId,
    });
    const activeTargets = allTargets.filter(
      (target) => target?.Status === "TargetStatusActive",
    );

    this.logger.info("Competitive cycle: active targets loaded", {
      activeTargets: activeTargets.length,
    });

    for (const target of activeTargets) {
      await this.processCompetitiveTarget(target);
    }
  }

  async processCompetitiveTarget(target) {
    const title = target?.Title;
    const targetId = target?.TargetID;
    const currentPriceUsd = parseNumber(target?.Price?.Amount);
    if (!title || !targetId || !Number.isFinite(currentPriceUsd)) {
      return;
    }

    const minOfferUsd = await this.getMinOfferUsdByTitle(title);
    if (!Number.isFinite(minOfferUsd)) {
      this.logger.warn("Competitive cycle: no offer data for title", {
        title,
      });
      return;
    }

    const targetStats = await this.getTargetStatsByTitle(title, { minOfferUsd });
    const prices = targetStats.strictAnyPrices || [];
    if (prices.length === 0) {
      this.logger.warn("Competitive cycle: no strict-any target prices", {
        title,
      });
      return;
    }

    const bestTargetUsd = roundUsd(prices[0]);
    const secondTargetUsd = prices.length > 1 ? roundUsd(prices[1]) : null;
    const maxAllowedUsd = roundUsd(
      minOfferUsd * (1 - config.bot.competitiveMinProfitMarginPct / 100),
    );
    const bidStepUsd = config.bot.competitiveBidStepUsd;
    const epsilon = 0.0001;

    if (
      currentPriceUsd - maxAllowedUsd > epsilon &&
      config.bot.competitiveDeleteUnprofitable
    ) {
      this.logger.warn("Competitive cycle: deleting unprofitable target", {
        title,
        targetId,
        currentPriceUsd: roundUsd(currentPriceUsd),
        maxAllowedUsd,
      });
      if (!config.bot.dryRun) {
        await this.deleteSingleTarget(targetId);
      }
      return;
    }

    if (currentPriceUsd > bestTargetUsd + epsilon) {
      this.logger.info("Competitive cycle: already first place", {
        title,
        targetId,
        currentPriceUsd: roundUsd(currentPriceUsd),
        bestTargetUsd,
      });
      return;
    }

    let desiredPriceUsd = null;
    let reason = null;
    if (currentPriceUsd + epsilon < bestTargetUsd) {
      desiredPriceUsd = roundUsd(bestTargetUsd + bidStepUsd);
      reason = "outbid";
    } else if (
      Math.abs(currentPriceUsd - bestTargetUsd) <= epsilon &&
      Number.isFinite(secondTargetUsd)
    ) {
      desiredPriceUsd = roundUsd(secondTargetUsd + bidStepUsd);
      reason = "equal_to_best_reprice";
    } else {
      this.logger.info("Competitive cycle: already on top", {
        title,
        targetId,
        currentPriceUsd: roundUsd(currentPriceUsd),
      });
      return;
    }

    if (!Number.isFinite(desiredPriceUsd)) {
      return;
    }

    if (desiredPriceUsd > maxAllowedUsd + epsilon) {
      if (config.bot.competitiveDeleteUnprofitable) {
        this.logger.warn("Competitive cycle: deleting target (profit guard)", {
          title,
          targetId,
          desiredPriceUsd,
          maxAllowedUsd,
          reason,
        });
        if (!config.bot.dryRun) {
          await this.deleteSingleTarget(targetId);
        }
      } else {
        this.logger.info("Competitive cycle: skip update by profit guard", {
          title,
          targetId,
          desiredPriceUsd,
          maxAllowedUsd,
          reason,
        });
      }
      return;
    }

    if (Math.abs(desiredPriceUsd - currentPriceUsd) < 0.005) {
      this.logger.info("Competitive cycle: no meaningful price delta", {
        title,
        targetId,
        currentPriceUsd: roundUsd(currentPriceUsd),
        desiredPriceUsd,
      });
      return;
    }

    const updateResult = await this.updateTargetPriceSafely({
      target,
      newPriceUsd: desiredPriceUsd,
    });
    this.logger.info("Competitive cycle: target update result", {
      title,
      targetId,
      currentPriceUsd: roundUsd(currentPriceUsd),
      desiredPriceUsd,
      reason,
      updateResult,
    });
  }

  async discoverTitlesFromMarket({
    maxPages = config.strategy.scanPages,
    pageSize = config.strategy.pageSize,
    progressEveryPages = 0,
    onProgress = null,
  } = {}) {
    let cursor = "";
    let page = 0;
    const titles = new Set();

    while (page < maxPages) {
      const response = await this.client.getMarketItems({
        gameId: config.bot.gameId,
        currency: config.bot.currency,
        limit: pageSize,
        cursor,
      });

      const objects = response?.objects || [];
      for (const item of objects) {
        if (item?.title) {
          titles.add(item.title);
        }
      }

      page += 1;
      const nextCursor = response?.cursor;
      if (
        typeof onProgress === "function" &&
        progressEveryPages > 0 &&
        page % progressEveryPages === 0
      ) {
        onProgress({
          page,
          maxPages,
          titlesFound: titles.size,
          hasNextPage: Boolean(nextCursor && nextCursor !== cursor),
        });
      }
      if (!nextCursor || nextCursor === cursor) {
        break;
      }
      cursor = nextCursor;
    }

    return [...titles];
  }

  async fetchAggregatedPricesByTitle(titles) {
    const byTitle = new Map();
    const chunks = chunkArray(titles, config.strategy.aggregateChunkSize);

    for (const [index, chunk] of chunks.entries()) {
      const response = await this.client.getAggregatedPrices({
        titles: chunk,
        limit: chunk.length,
        offset: 0,
      });
      const aggregated = response?.AggregatedTitles || [];
      for (const item of aggregated) {
        if (item?.MarketHashName) {
          byTitle.set(item.MarketHashName, item);
        }
      }

      this.logger.info("Aggregated price chunk loaded", {
        chunkIndex: index + 1,
        totalChunks: chunks.length,
        requestedTitles: chunk.length,
        returned: aggregated.length,
      });
    }

    return byTitle;
  }

  async analyzeTitles(titles) {
    const pricingRows = await this.analyzeTitlesPricing(titles, {
      targetsConcurrency: config.bot.analysisTargetsConcurrency,
    });
    if (pricingRows.length === 0) {
      return [];
    }

    const syntheticAggregated = pricingRows.map((row) => ({
      MarketHashName: row.title,
      Offers: {
        BestPrice: `${row.minOfferUsd}`,
        Count: row.offerCount,
      },
      Orders: {
        BestPrice: `${row.maxTargetUsd}`,
        Count: row.targetStrictAnyOrdersCount || row.orderCount || 0,
      },
    }));

    return buildOpportunities(syntheticAggregated, {
      strategy: config.strategy,
      priceInCoins: false,
    });
  }

  async getTargetStatsByTitle(title, { minOfferUsd = null } = {}) {
    try {
      const response = await this.client.getTargetsByTitle({
        gameId: config.bot.gameId,
        title,
      });
      const orders = extractTargetOrdersArray(response);

      const allPrices = [];
      let strictAnyPrices = [];
      for (const order of orders) {
        const priceUsd = extractOrderPriceUsd(
          order,
          config.dmarket.targetsByTitlePricesInCoins,
        );
        if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
          continue;
        }

        allPrices.push(priceUsd);
        if (isDefaultAnyTargetOrder(order)) {
          strictAnyPrices.push(priceUsd);
        }
      }

      let scaleAdjusted = false;
      if (strictAnyPrices.length > 0 && Number.isFinite(minOfferUsd)) {
        const range = normalizeTargetRangeByOffer({
          minTargetUsd: Math.min(...strictAnyPrices),
          maxTargetUsd: Math.max(...strictAnyPrices),
          minOfferUsd,
        });
        if (range.scaleAdjusted) {
          scaleAdjusted = true;
          strictAnyPrices = strictAnyPrices.map((price) => roundUsd(price / 100));
        }
      }

      strictAnyPrices = strictAnyPrices.sort((a, b) => b - a);
      const selectedPrices = strictAnyPrices;
      const minTargetUsd =
        selectedPrices.length > 0 ? roundUsd(Math.min(...selectedPrices)) : null;
      const maxTargetUsd =
        selectedPrices.length > 0 ? roundUsd(Math.max(...selectedPrices)) : null;

      return {
        minTargetUsd,
        maxTargetUsd,
        rawResponse: response,
        totalOrdersCount: orders.length,
        parsedPricesCount: allPrices.length,
        strictAnyPrices,
        strictAnyOrdersCount: strictAnyPrices.length,
        scaleAdjusted,
        selectedSource:
          strictAnyPrices.length > 0 ? "strict_any_orders" : "no_strict_any_orders",
      };
    } catch (error) {
      this.logger.warn("Failed to fetch targets-by-title", {
        title,
        message: error.message,
        status: error.status,
      });
      return {
        minTargetUsd: null,
        maxTargetUsd: null,
        rawResponse: null,
        totalOrdersCount: 0,
        parsedPricesCount: 0,
        strictAnyOrdersCount: 0,
        scaleAdjusted: false,
        selectedSource: "unavailable",
      };
    }
  }

  async analyzeTitlesPricing(
    titles,
    {
      targetsConcurrency = config.bot.analysisTargetsConcurrency,
      progressEvery = 0,
      onProgress = null,
    } = {},
  ) {
    const uniqueTitles = [...new Set(titles.map((title) => title.trim()))].filter(
      Boolean,
    );

    if (uniqueTitles.length === 0) {
      return [];
    }

    const aggregatedByTitle = await this.fetchAggregatedPricesByTitle(uniqueTitles);
    const rows = new Array(uniqueTitles.length).fill(null);
    const safeConcurrency = Math.max(1, Math.floor(targetsConcurrency));
    let index = 0;
    let processed = 0;

    const worker = async () => {
      while (true) {
        const currentIndex = index;
        index += 1;
        if (currentIndex >= uniqueTitles.length) {
          return;
        }

        const title = uniqueTitles[currentIndex];
        const raw = aggregatedByTitle.get(title);
        if (!raw) {
          processed += 1;
          if (
            typeof onProgress === "function" &&
            progressEvery > 0 &&
            processed % progressEvery === 0
          ) {
            onProgress({ processed, total: uniqueTitles.length });
          }
          continue;
        }

        const minOfferUsd = toUsd(
          raw?.Offers?.BestPrice,
          config.dmarket.aggregatedPricesInCoins,
        );
        const offerCount = parseNumber(raw?.Offers?.Count) || 0;
        const orderCount = parseNumber(raw?.Orders?.Count) || 0;

        if (!Number.isFinite(minOfferUsd) || minOfferUsd <= 0) {
          processed += 1;
          if (
            typeof onProgress === "function" &&
            progressEvery > 0 &&
            processed % progressEvery === 0
          ) {
            onProgress({ processed, total: uniqueTitles.length });
          }
          continue;
        }

        const targetStats = await this.getTargetStatsByTitle(title, {
          minOfferUsd,
        });
        if (!Number.isFinite(targetStats.maxTargetUsd)) {
          processed += 1;
          if (
            typeof onProgress === "function" &&
            progressEvery > 0 &&
            processed % progressEvery === 0
          ) {
            onProgress({ processed, total: uniqueTitles.length });
          }
          continue;
        }

        const maxTargetUsd = targetStats.maxTargetUsd;
        const minTargetUsd = Number.isFinite(targetStats.minTargetUsd)
          ? targetStats.minTargetUsd
          : targetStats.maxTargetUsd;
        const edgePct =
          minOfferUsd > 0
            ? roundUsd(((maxTargetUsd - minOfferUsd) / minOfferUsd) * 100)
            : 0;
        const roiPct = edgePct;

        rows[currentIndex] = {
          title,
          maxTargetUsd,
          minTargetUsd,
          minOfferUsd: roundUsd(minOfferUsd),
          targetPriceUsd: maxTargetUsd,
          orderBestUsd: roundUsd(minOfferUsd),
          targetBestUsd: maxTargetUsd,
          edgePct,
          roiPct,
          offerCount,
          orderCount,
          targetSource: targetStats.selectedSource,
          targetOrdersCount: targetStats.totalOrdersCount,
          targetStrictAnyOrdersCount: targetStats.strictAnyOrdersCount,
          targetScaleAdjusted: targetStats.scaleAdjusted,
          rawTargetsByTitle: targetStats.rawResponse,
        };

        processed += 1;
        if (
          typeof onProgress === "function" &&
          progressEvery > 0 &&
          processed % progressEvery === 0
        ) {
          onProgress({ processed, total: uniqueTitles.length });
        }
      }
    };

    const workers = [];
    for (let i = 0; i < safeConcurrency; i += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);

    return rows.filter(Boolean);
  }

  async getMonthlySalesCount(
    title,
    { days = 30, pageLimit = 20, maxPages = 12, stopAt = null } = {},
  ) {
    const now = Math.floor(Date.now() / 1000);
    const fromTimestamp = now - days * 24 * 60 * 60;
    const safePageLimit = Math.max(1, Math.min(20, Math.floor(pageLimit)));

    let page = 0;
    let offset = 0;
    let count = 0;
    let hadAnySalesRows = false;

    while (page < maxPages) {
      const response = await this.client.getLastSales({
        gameId: config.bot.gameId,
        title,
        limit: safePageLimit,
        offset,
      });

      const sales = extractSalesArray(response);
      if (sales.length === 0) {
        break;
      }
      hadAnySalesRows = true;

      let sawOlderSale = false;
      let parsedTimestampRows = 0;
      for (const sale of sales) {
        const ts = extractSaleTimestamp(sale);
        if (ts === null) {
          continue;
        }
        parsedTimestampRows += 1;

        if (ts >= fromTimestamp) {
          count += 1;
          if (stopAt !== null && count >= stopAt) {
            return count;
          }
        } else {
          sawOlderSale = true;
        }
      }

      // Fallback for unexpected response format: if rows exist but dates are absent,
      // use row count from the first page as a conservative monthly proxy.
      if (parsedTimestampRows === 0 && page === 0 && sales.length > 0) {
        return sales.length;
      }

      if (sawOlderSale || sales.length < safePageLimit) {
        break;
      }

      page += 1;
      offset += safePageLimit;
    }

    if (!hadAnySalesRows) {
      return 0;
    }

    return count;
  }

  async filterOpportunitiesByMonthlySales(
    opportunities,
    {
      minSalesPerMonth = config.bot.analysisMinMonthlySales,
      concurrency = config.bot.analysisSalesConcurrency,
      days = 30,
      progressEvery = 0,
      onProgress = null,
    } = {},
  ) {
    const safeConcurrency = Math.max(1, Math.floor(concurrency));
    const enriched = [];
    let index = 0;
    let sourceZeroCount = 0;
    let checkedCount = 0;

    const worker = async () => {
      while (true) {
        const currentIndex = index;
        index += 1;
        if (currentIndex >= opportunities.length) {
          return;
        }

        const opportunity = opportunities[currentIndex];
        const monthlySales = await this.getMonthlySalesCount(opportunity.title, {
          days,
          stopAt: minSalesPerMonth,
        });
        checkedCount += 1;

        if (
          typeof onProgress === "function" &&
          progressEvery > 0 &&
          checkedCount % progressEvery === 0
        ) {
          onProgress({
            checkedCount,
            total: opportunities.length,
            passed: enriched.length,
          });
        }

        if (monthlySales >= minSalesPerMonth) {
          enriched.push({
            ...opportunity,
            monthlySales,
          });
        } else if (monthlySales === 0) {
          sourceZeroCount += 1;
        }
      }
    };

    const workers = [];
    for (let i = 0; i < safeConcurrency; i += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);

    this.logger.info("Monthly sales filter summary", {
      checked: opportunities.length,
      passed: enriched.length,
      zeroSalesCount: sourceZeroCount,
      minSalesPerMonth,
      days,
    });

    if (
      enriched.length === 0 &&
      opportunities.length > 0 &&
      sourceZeroCount === opportunities.length
    ) {
      this.logger.warn(
        "Last-sales endpoint returned zero for all titles. Falling back to liquidity proxy.",
      );
      return opportunities
        .map((entry) => ({
          ...entry,
          monthlySales: Math.max(entry.offerCount || 0, entry.orderCount || 0),
          monthlySalesSource: "liquidity_proxy",
        }))
        .filter((entry) => entry.monthlySales >= minSalesPerMonth);
    }

    return enriched;
  }

  async createTargetsForOpportunities(
    opportunities,
    { maxNewTargets = config.strategy.newTargetsPerCycle } = {},
  ) {
    await this.initialize();

    const [balance, activeTargets] = await Promise.all([
      this.client.getBalance(),
      this.client.getAllUserTargets({ gameId: config.bot.gameId }),
    ]);
    const balanceUsd = parseBalanceUsd(balance, config.dmarket.priceInCoins);

    const activeTargetsByTitle = new Map(
      activeTargets
        .filter((target) => target?.Title)
        .map((target) => [target.Title, target]),
    );
    const currentManagedTargets = this.stateStore
      .getManagedTitles()
      .map((title) => activeTargetsByTitle.get(title))
      .filter(Boolean);

    let committedUsd = 0;
    for (const target of currentManagedTargets) {
      const priceUsd = parseTargetPriceUsd(target) || 0;
      const amount = Math.max(1, Math.floor(parseNumber(target.Amount) || 1));
      committedUsd += priceUsd * amount;
    }

    const budgetCapUsd = Math.min(
      config.strategy.maxBudgetUsd,
      balanceUsd * config.strategy.balanceUsageRatio,
    );
    const availableBudgetUsd = Math.max(0, budgetCapUsd - committedUsd);
    const freeSlots = Math.max(
      0,
      config.strategy.maxManagedTargets - currentManagedTargets.length,
    );

    const strategyForNew = {
      ...config.strategy,
      newTargetsPerCycle: Math.min(maxNewTargets, freeSlots),
    };
    const occupiedTitles = [
      ...new Set(activeTargets.map((target) => target?.Title).filter(Boolean)),
    ];

    const createPlans = planNewTargets({
      opportunities,
      managedTitles: occupiedTitles,
      strategy: strategyForNew,
      availableBudgetUsd,
    });

    await this.applyCreatePlans(createPlans);
    await this.stateStore.save();

    return {
      createPlans,
      balanceUsd: roundUsd(balanceUsd),
      committedUsd: roundUsd(committedUsd),
      availableBudgetUsd: roundUsd(availableBudgetUsd),
      freeSlots,
    };
  }

  async runCycleSafe() {
    if (this.isCycleRunning) {
      this.logger.warn("Skipping cycle: previous cycle is still running");
      return;
    }

    this.isCycleRunning = true;
    const startedAt = Date.now();

    try {
      await this.runCycle();
      this.logger.info("Cycle finished", {
        durationSec: roundUsd((Date.now() - startedAt) / 1000),
      });
    } catch (error) {
      this.logger.error("Cycle failed", {
        message: error.message,
        stack: error.stack,
        status: error.status,
        payload: error.payload,
      });
    } finally {
      this.isCycleRunning = false;
    }
  }

  async runCycle() {
    await this.initialize();
    this.logger.info("Starting cycle");

    const [balance, activeTargets] = await Promise.all([
      this.client.getBalance(),
      this.client.getAllUserTargets({ gameId: config.bot.gameId }),
    ]);

    const balanceUsd = parseBalanceUsd(balance, config.dmarket.priceInCoins);
    this.logger.info("Fetched account context", {
      balanceUsd: roundUsd(balanceUsd),
      activeTargets: activeTargets.length,
    });

    const removedTitles = this.stateStore.pruneMissingTargets(activeTargets);
    if (removedTitles.length > 0) {
      this.logger.warn("Removed stale state entries", { removedTitles });
    }

    const titles = await this.discoverTitlesFromMarket();
    if (titles.length === 0) {
      this.logger.warn("No titles discovered in market scan. Skipping cycle.");
      await this.stateStore.save();
      return;
    }

    this.logger.info("Market titles discovered", { titles: titles.length });
    const opportunities = await this.analyzeTitles(titles);
    const opportunitiesByTitle = new Map(
      opportunities.map((entry) => [entry.title, entry]),
    );

    this.logger.info("Profit opportunities built", {
      candidates: opportunities.length,
      sampleTop: opportunities.slice(0, 5).map((entry) => ({
        title: entry.title,
        targetPriceUsd: entry.targetPriceUsd,
        expectedProfitUsd: entry.profitUsd,
        roiPct: entry.roiPct,
      })),
    });

    const activeTargetsByTitle = new Map(
      activeTargets
        .filter((target) => target?.Title)
        .map((target) => [target.Title, target]),
    );

    const managedTargets = this.stateStore
      .getManagedTitles()
      .map((title) => activeTargetsByTitle.get(title))
      .filter(Boolean);

    this.logger.info("Managed targets loaded", {
      managedCount: managedTargets.length,
    });

    const updateActions = planManagedUpdates({
      managedTargets,
      opportunitiesByTitle,
      strategy: config.strategy,
    });
    await this.applyManagedActions(updateActions);

    const refreshedActiveTargets = await this.client.getAllUserTargets({
      gameId: config.bot.gameId,
    });
    const refreshedByTitle = new Map(
      refreshedActiveTargets
        .filter((target) => target?.Title)
        .map((target) => [target.Title, target]),
    );

    const currentManagedTitles = this.stateStore
      .getManagedTitles()
      .filter((title) => refreshedByTitle.has(title));
    const currentManagedTargets = currentManagedTitles
      .map((title) => refreshedByTitle.get(title))
      .filter(Boolean);

    let committedUsd = 0;
    for (const target of currentManagedTargets) {
      const priceUsd = parseTargetPriceUsd(target) || 0;
      const amount = Math.max(1, Math.floor(parseNumber(target.Amount) || 1));
      committedUsd += priceUsd * amount;
    }

    const budgetCapUsd = Math.min(
      config.strategy.maxBudgetUsd,
      balanceUsd * config.strategy.balanceUsageRatio,
    );
    const availableBudgetUsd = Math.max(0, budgetCapUsd - committedUsd);
    const freeSlots = Math.max(
      0,
      config.strategy.maxManagedTargets - currentManagedTargets.length,
    );
    const strategyForNew = {
      ...config.strategy,
      newTargetsPerCycle: Math.min(config.strategy.newTargetsPerCycle, freeSlots),
    };

    const occupiedTitles = [
      ...new Set(
        refreshedActiveTargets.map((target) => target?.Title).filter(Boolean),
      ),
    ];

    const createPlans = planNewTargets({
      opportunities,
      managedTitles: occupiedTitles,
      strategy: strategyForNew,
      availableBudgetUsd,
    });

    await this.applyCreatePlans(createPlans);
    await this.stateStore.save();

    this.logger.info("Cycle summary", {
      opportunities: opportunities.length,
      updatesPlanned: updateActions.filter((a) => a.type === "replace").length,
      deletesPlanned: updateActions.filter((a) => a.type === "delete").length,
      createsPlanned: createPlans.length,
      availableBudgetUsd: roundUsd(availableBudgetUsd),
      committedUsd: roundUsd(committedUsd),
      managedAfter: this.stateStore.getManagedTitles().length,
    });
  }

  async applyManagedActions(actions) {
    const keepActions = actions.filter((action) => action.type === "keep");
    const deleteActions = actions.filter((action) => action.type === "delete");
    const replaceActions = actions.filter((action) => action.type === "replace");

    for (const action of keepActions) {
      this.logger.info("Target is on top or near-optimal", {
        title: action.title,
        targetId: action.targetId,
        priceUsd: action.priceUsd,
      });
    }

    if (deleteActions.length > 0) {
      const ids = deleteActions.map((action) => action.targetId);
      this.logger.info("Deleting unprofitable managed targets", {
        count: ids.length,
      });

      if (!config.bot.dryRun) {
        for (const chunk of chunkArray(ids, 100)) {
          await this.client.deleteTargets({ targetIds: chunk });
        }
      }

      for (const action of deleteActions) {
        this.stateStore.removeManagedTargetByTitle(action.title);
      }
    }

    for (const action of replaceActions) {
      this.logger.info("Replacing managed target price", {
        title: action.title,
        oldPriceUsd: action.oldPriceUsd,
        newPriceUsd: action.newPriceUsd,
        reason: action.reason,
      });

      if (config.bot.dryRun) {
        this.stateStore.upsertManagedTarget({
          title: action.title,
          targetId: action.oldTargetId,
          gameId: config.bot.gameId,
          amount: action.amount,
          priceUsd: action.newPriceUsd,
          metadata: {
            dryRun: true,
            reason: action.reason,
          },
        });
        continue;
      }

      await this.client.deleteTargets({ targetIds: [action.oldTargetId] });

      const createResponse = await this.client.createTargets({
        gameId: config.bot.gameId,
        targets: [
          toTargetPayload({
            title: action.title,
            amount: action.amount,
            priceUsd: action.newPriceUsd,
            currency: config.bot.currency,
          }),
        ],
      });

      const result = createResponse?.Result?.[0];
      if (!result?.Successful || !result?.TargetID) {
        this.logger.error("Failed to recreate target after delete", {
          title: action.title,
          result,
        });
        this.stateStore.removeManagedTargetByTitle(action.title);
        continue;
      }

      this.stateStore.upsertManagedTarget({
        title: action.title,
        targetId: result.TargetID,
        gameId: config.bot.gameId,
        amount: action.amount,
        priceUsd: action.newPriceUsd,
        metadata: {
          reason: action.reason,
        },
      });
    }
  }

  async applyCreatePlans(createPlans) {
    for (const plan of createPlans) {
      this.logger.info("Creating new profitable target", {
        title: plan.title,
        amount: plan.amount,
        priceUsd: plan.priceUsd,
        expectedProfitUsd: plan.metrics.profitUsd,
        roiPct: plan.metrics.roiPct,
      });

      if (config.bot.dryRun) {
        this.stateStore.upsertManagedTarget({
          title: plan.title,
          targetId: `dry-run-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          gameId: config.bot.gameId,
          amount: plan.amount,
          priceUsd: plan.priceUsd,
          metadata: {
            dryRun: true,
            reason: plan.reason,
          },
        });
        continue;
      }

      const response = await this.client.createTargets({
        gameId: config.bot.gameId,
        targets: [
          toTargetPayload({
            title: plan.title,
            amount: plan.amount,
            priceUsd: plan.priceUsd,
            currency: config.bot.currency,
          }),
        ],
      });

      const result = response?.Result?.[0];
      if (!result?.Successful || !result?.TargetID) {
        this.logger.error("Target creation failed", {
          title: plan.title,
          result,
        });
        continue;
      }

      this.stateStore.upsertManagedTarget({
        title: plan.title,
        targetId: result.TargetID,
        gameId: config.bot.gameId,
        amount: plan.amount,
        priceUsd: plan.priceUsd,
        metadata: {
          reason: plan.reason,
          profitUsd: plan.metrics.profitUsd,
          roiPct: plan.metrics.roiPct,
        },
      });
    }
  }
}
