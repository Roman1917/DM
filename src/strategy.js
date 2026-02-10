const {
  maxTargetByProfitability,
  parseNumber,
  roundUsd,
  toUsd,
} = require("./utils");

function parseTargetPriceUsd(target) {
  const amount = parseNumber(target?.Price?.Amount);
  if (amount === null) {
    return null;
  }

  return amount;
}

function normalizeAggregatedTitle(raw, { priceInCoins }) {
  const offerBestUsd = toUsd(raw?.Offers?.BestPrice, priceInCoins);
  const orderBestUsd = toUsd(raw?.Orders?.BestPrice, priceInCoins);
  const offerCount = parseNumber(raw?.Offers?.Count) || 0;
  const orderCount = parseNumber(raw?.Orders?.Count) || 0;

  return {
    title: raw?.MarketHashName || "",
    offerBestUsd,
    orderBestUsd: orderBestUsd || 0,
    offerCount,
    orderCount,
  };
}

function computeTargetAmount({
  remainingBudgetUsd,
  targetPriceUsd,
  maxAmountPerTarget,
}) {
  if (targetPriceUsd <= 0 || remainingBudgetUsd < targetPriceUsd) {
    return 0;
  }

  const maxAffordable = Math.floor(remainingBudgetUsd / targetPriceUsd);
  return Math.max(0, Math.min(maxAmountPerTarget, maxAffordable, 100));
}

function evaluateOpportunity(normalized, strategy) {
  const {
    offerBestUsd,
    orderBestUsd,
    offerCount,
    orderCount,
    title,
  } = normalized;

  if (!title || !offerBestUsd || offerBestUsd <= 0) {
    return null;
  }

  if (offerCount < strategy.minOffersCount) {
    return null;
  }

  if (orderCount < strategy.minOrdersCount) {
    return null;
  }

  if (offerBestUsd < strategy.minBuyPriceUsd) {
    return null;
  }

  if (offerBestUsd > strategy.maxBuyPriceUsd) {
    return null;
  }

  const spreadUsd = offerBestUsd - orderBestUsd;
  if (spreadUsd < strategy.minSpreadUsd) {
    return null;
  }

  const expectedSellUsd =
    offerBestUsd * (1 - strategy.quickSaleDiscountPct / 100);
  const maxTargetUsd = maxTargetByProfitability({
    expectedSellUsd,
    saleCommissionPct: strategy.saleCommissionPct,
    minProfitUsd: strategy.minProfitUsd,
    minRoiPct: strategy.minRoiPct,
  });

  if (!Number.isFinite(maxTargetUsd) || maxTargetUsd <= 0) {
    return null;
  }

  const bidToBeatUsd =
    orderBestUsd > 0
      ? orderBestUsd + strategy.bidStepUsd
      : offerBestUsd * strategy.noOrderBidRatio;

  let targetPriceUsd = Math.min(maxTargetUsd, bidToBeatUsd);
  targetPriceUsd = roundUsd(Math.max(targetPriceUsd, strategy.minBuyPriceUsd));

  const netSellUsd = expectedSellUsd * (1 - strategy.saleCommissionPct / 100);
  const profitUsd = netSellUsd - targetPriceUsd;
  const roiPct = targetPriceUsd > 0 ? (profitUsd / targetPriceUsd) * 100 : 0;

  if (profitUsd < strategy.minProfitUsd || roiPct < strategy.minRoiPct) {
    return null;
  }

  const liquidityWeight =
    1 + Math.log1p(Math.min(offerCount, orderCount || 1));
  const score = profitUsd * liquidityWeight;

  return {
    title,
    offerBestUsd: roundUsd(offerBestUsd),
    orderBestUsd: roundUsd(orderBestUsd),
    spreadUsd: roundUsd(spreadUsd),
    expectedSellUsd: roundUsd(expectedSellUsd),
    targetPriceUsd,
    netSellUsd: roundUsd(netSellUsd),
    profitUsd: roundUsd(profitUsd),
    roiPct: roundUsd(roiPct),
    offerCount,
    orderCount,
    score,
  };
}

function buildOpportunities(aggregatedTitles, { strategy, priceInCoins }) {
  return aggregatedTitles
    .map((entry) => normalizeAggregatedTitle(entry, { priceInCoins }))
    .map((normalized) => evaluateOpportunity(normalized, strategy))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

function planManagedUpdates({
  managedTargets,
  opportunitiesByTitle,
  strategy,
}) {
  const actions = [];

  for (const target of managedTargets) {
    const title = target.Title;
    const currentPriceUsd = parseTargetPriceUsd(target);
    const amount = Math.max(1, Math.floor(parseNumber(target.Amount) || 1));

    if (!title || currentPriceUsd === null) {
      continue;
    }

    const opportunity = opportunitiesByTitle.get(title);
    if (!opportunity) {
      actions.push({
        type: "delete",
        title,
        targetId: target.TargetID,
        reason: "no_longer_profitable",
      });
      continue;
    }

    const notFirst = currentPriceUsd + 0.0001 < opportunity.orderBestUsd;
    const desiredPriceUsd = opportunity.targetPriceUsd;
    const deltaUsd = Math.abs(desiredPriceUsd - currentPriceUsd);

    if (deltaUsd < strategy.minPriceUpdateDeltaUsd && !notFirst) {
      actions.push({
        type: "keep",
        title,
        targetId: target.TargetID,
        priceUsd: currentPriceUsd,
        amount,
        reason: "already_optimal",
      });
      continue;
    }

    actions.push({
      type: "replace",
      title,
      oldTargetId: target.TargetID,
      amount,
      oldPriceUsd: roundUsd(currentPriceUsd),
      newPriceUsd: roundUsd(desiredPriceUsd),
      reason: notFirst ? "outbid" : "rebalance_price",
    });
  }

  return actions;
}

function planNewTargets({
  opportunities,
  managedTitles,
  strategy,
  availableBudgetUsd,
}) {
  const plans = [];
  const occupied = new Set(managedTitles);
  const maxNewTargets = Math.max(0, Math.floor(strategy.newTargetsPerCycle));
  let remainingBudgetUsd = availableBudgetUsd;

  for (const opportunity of opportunities) {
    if (plans.length >= maxNewTargets) {
      break;
    }

    if (occupied.has(opportunity.title)) {
      continue;
    }

    const amount = computeTargetAmount({
      remainingBudgetUsd,
      targetPriceUsd: opportunity.targetPriceUsd,
      maxAmountPerTarget: strategy.maxAmountPerTarget,
    });

    if (amount <= 0) {
      continue;
    }

    plans.push({
      type: "create",
      title: opportunity.title,
      amount,
      priceUsd: opportunity.targetPriceUsd,
      reason: "new_profitable_target",
      metrics: opportunity,
    });
    occupied.add(opportunity.title);
    remainingBudgetUsd -= opportunity.targetPriceUsd * amount;
  }

  return plans;
}

module.exports = {
  buildOpportunities,
  planManagedUpdates,
  planNewTargets,
  parseTargetPriceUsd,
};
