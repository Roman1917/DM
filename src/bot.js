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
  floorUsd,
  maxTargetByProfitability,
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

export class DMarketTargetBot {
  constructor({ loggerInstance = logger } = {}) {
    this.logger = loggerInstance;
    this.client = new DMarketClient({
      config: config.dmarket,
      logger: this.logger,
    });
    this.stateStore = new StateStore(config.bot.statePath);
    this.isCycleRunning = false;
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
    const uniqueTitles = [...new Set(titles.map((title) => title.trim()))].filter(
      Boolean,
    );

    if (uniqueTitles.length === 0) {
      return [];
    }

    const aggregatedByTitle = await this.fetchAggregatedPricesByTitle(uniqueTitles);
    return buildOpportunities([...aggregatedByTitle.values()], {
      strategy: config.strategy,
      priceInCoins: config.dmarket.aggregatedPricesInCoins,
    });
  }

  async analyzeTitlesPricing(titles) {
    const uniqueTitles = [...new Set(titles.map((title) => title.trim()))].filter(
      Boolean,
    );

    if (uniqueTitles.length === 0) {
      return [];
    }

    const aggregatedByTitle = await this.fetchAggregatedPricesByTitle(uniqueTitles);
    const rows = [];

    for (const title of uniqueTitles) {
      const raw = aggregatedByTitle.get(title);
      if (!raw) {
        continue;
      }

      const minOfferUsd = toUsd(
        raw?.Offers?.BestPrice,
        config.dmarket.aggregatedPricesInCoins,
      );
      const bestOrderUsd =
        toUsd(raw?.Orders?.BestPrice, config.dmarket.aggregatedPricesInCoins) || 0;
      const offerCount = parseNumber(raw?.Offers?.Count) || 0;
      const orderCount = parseNumber(raw?.Orders?.Count) || 0;

      if (!Number.isFinite(minOfferUsd) || minOfferUsd <= 0) {
        continue;
      }

      const expectedSellUsd =
        minOfferUsd * (1 - config.strategy.quickSaleDiscountPct / 100);
      const rawMaxTargetUsd = maxTargetByProfitability({
        expectedSellUsd,
        saleCommissionPct: config.strategy.saleCommissionPct,
        minProfitUsd: config.strategy.minProfitUsd,
        minRoiPct: config.strategy.minRoiPct,
      });
      const maxTargetUsd = floorUsd(Math.max(0, rawMaxTargetUsd || 0));

      const bidToBeatUsd =
        bestOrderUsd > 0
          ? bestOrderUsd + config.strategy.bidStepUsd
          : minOfferUsd * config.strategy.noOrderBidRatio;
      const targetPriceUsd = floorUsd(
        Math.max(
          config.strategy.minBuyPriceUsd,
          Math.min(maxTargetUsd || config.strategy.minBuyPriceUsd, bidToBeatUsd),
        ),
      );

      const netSellUsd =
        expectedSellUsd * (1 - config.strategy.saleCommissionPct / 100);
      const edgePct =
        minOfferUsd > 0
          ? roundUsd(((maxTargetUsd - minOfferUsd) / minOfferUsd) * 100)
          : 0;
      const roiPct =
        targetPriceUsd > 0
          ? roundUsd(((netSellUsd - targetPriceUsd) / targetPriceUsd) * 100)
          : 0;

      rows.push({
        title,
        maxTargetUsd: roundUsd(maxTargetUsd),
        minOfferUsd: roundUsd(minOfferUsd),
        targetPriceUsd: roundUsd(targetPriceUsd),
        orderBestUsd: roundUsd(bestOrderUsd),
        expectedSellUsd: roundUsd(expectedSellUsd),
        netSellUsd: roundUsd(netSellUsd),
        edgePct,
        roiPct,
        offerCount,
        orderCount,
      });
    }

    return rows;
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
