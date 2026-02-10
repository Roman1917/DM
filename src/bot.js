const { config } = require("./config");
const { DMarketClient } = require("./dmarketClient");
const { logger } = require("./logger");
const { StateStore } = require("./stateStore");
const {
  buildOpportunities,
  parseTargetPriceUsd,
  planManagedUpdates,
  planNewTargets,
} = require("./strategy");
const { chunkArray, parseNumber, roundUsd, toUsd } = require("./utils");

function parseBalanceUsd(balance, priceInCoins) {
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

class DMarketTargetBot {
  constructor() {
    this.client = new DMarketClient({
      config: config.dmarket,
      logger,
    });
    this.stateStore = new StateStore(config.bot.statePath);
    this.isCycleRunning = false;
  }

  async start() {
    await this.stateStore.load();
    logger.info("State loaded", {
      statePath: config.bot.statePath,
      managedTitles: this.stateStore.getManagedTitles().length,
    });

    await this.runCycleSafe();
    this.intervalId = setInterval(
      () => this.runCycleSafe(),
      config.bot.intervalMs,
    );

    logger.info("Bot started", {
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

  async runCycleSafe() {
    if (this.isCycleRunning) {
      logger.warn("Skipping cycle: previous cycle is still running");
      return;
    }

    this.isCycleRunning = true;
    const startedAt = Date.now();

    try {
      await this.runCycle();
      logger.info("Cycle finished", {
        durationSec: roundUsd((Date.now() - startedAt) / 1000),
      });
    } catch (error) {
      logger.error("Cycle failed", {
        message: error.message,
        stack: error.stack,
        status: error.status,
        payload: error.payload,
      });
    } finally {
      this.isCycleRunning = false;
    }
  }

  async discoverTitlesFromMarket() {
    let cursor = "";
    let page = 0;
    const titles = new Set();

    while (page < config.strategy.scanPages) {
      const response = await this.client.getMarketItems({
        gameId: config.bot.gameId,
        currency: config.bot.currency,
        limit: config.strategy.pageSize,
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

      logger.info("Aggregated price chunk loaded", {
        chunkIndex: index + 1,
        totalChunks: chunks.length,
        requestedTitles: chunk.length,
        returned: aggregated.length,
      });
    }

    return byTitle;
  }

  async runCycle() {
    logger.info("Starting cycle");

    const [balance, activeTargets] = await Promise.all([
      this.client.getBalance(),
      this.client.getAllUserTargets({ gameId: config.bot.gameId }),
    ]);

    const balanceUsd = parseBalanceUsd(balance, config.dmarket.priceInCoins);
    logger.info("Fetched account context", {
      balanceUsd: roundUsd(balanceUsd),
      activeTargets: activeTargets.length,
    });

    const removedTitles = this.stateStore.pruneMissingTargets(activeTargets);
    if (removedTitles.length > 0) {
      logger.warn("Removed stale state entries", { removedTitles });
    }

    const titles = await this.discoverTitlesFromMarket();
    if (titles.length === 0) {
      logger.warn("No titles discovered in market scan. Skipping cycle.");
      await this.stateStore.save();
      return;
    }

    logger.info("Market titles discovered", { titles: titles.length });
    const aggregatedByTitle = await this.fetchAggregatedPricesByTitle(titles);
    const opportunities = buildOpportunities([...aggregatedByTitle.values()], {
      strategy: config.strategy,
      priceInCoins: config.dmarket.priceInCoins,
    });
    const opportunitiesByTitle = new Map(
      opportunities.map((entry) => [entry.title, entry]),
    );

    logger.info("Profit opportunities built", {
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

    logger.info("Managed targets loaded", {
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

    logger.info("Cycle summary", {
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
      logger.info("Target is on top or near-optimal", {
        title: action.title,
        targetId: action.targetId,
        priceUsd: action.priceUsd,
      });
    }

    if (deleteActions.length > 0) {
      const ids = deleteActions.map((action) => action.targetId);
      logger.info("Deleting unprofitable managed targets", {
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
      logger.info("Replacing managed target price", {
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
        logger.error("Failed to recreate target after delete", {
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
      logger.info("Creating new profitable target", {
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
        logger.error("Target creation failed", {
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

async function main() {
  const bot = new DMarketTargetBot();
  await bot.start();

  const shutdown = async (signal) => {
    logger.warn(`Received ${signal}. Stopping bot...`);
    bot.stop();
    try {
      await bot.stateStore.save();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error("Bot startup failed", {
    message: error.message,
    stack: error.stack,
  });
  process.exit(1);
});
