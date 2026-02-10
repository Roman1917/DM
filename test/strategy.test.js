import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOpportunities,
  planManagedUpdates,
  planNewTargets,
} from "../src/strategy.js";

const baseStrategy = {
  saleCommissionPct: 2,
  quickSaleDiscountPct: 0.5,
  minProfitUsd: 0.08,
  minRoiPct: 2.5,
  minSpreadUsd: 0.05,
  bidStepUsd: 0.01,
  noOrderBidRatio: 0.65,
  minOffersCount: 2,
  minOrdersCount: 1,
  maxBuyPriceUsd: 40,
  minBuyPriceUsd: 0.1,
  maxAmountPerTarget: 1,
  newTargetsPerCycle: 10,
  minPriceUpdateDeltaUsd: 0.005,
};

test("buildOpportunities returns profitable candidates", () => {
  const aggregated = [
    {
      MarketHashName: "AK-47 | Redline (Field-Tested)",
      Offers: {
        BestPrice: "150",
        Count: 20,
      },
      Orders: {
        BestPrice: "120",
        Count: 15,
      },
    },
  ];

  const opportunities = buildOpportunities(aggregated, {
    strategy: baseStrategy,
    priceInCoins: true,
  });

  assert.equal(opportunities.length, 1);
  assert.equal(opportunities[0].title, "AK-47 | Redline (Field-Tested)");
  assert.ok(opportunities[0].profitUsd >= 0.08);
  assert.ok(opportunities[0].roiPct >= 2.5);
});

test("buildOpportunities filters too small spread", () => {
  const aggregated = [
    {
      MarketHashName: "USP-S | Cortex (Field-Tested)",
      Offers: {
        BestPrice: "100",
        Count: 10,
      },
      Orders: {
        BestPrice: "98",
        Count: 8,
      },
    },
  ];

  const opportunities = buildOpportunities(aggregated, {
    strategy: baseStrategy,
    priceInCoins: true,
  });

  assert.equal(opportunities.length, 0);
});

test("planManagedUpdates replaces target when outbid", () => {
  const opportunitiesByTitle = new Map([
    [
      "M4A1-S | Decimator (Field-Tested)",
      {
        title: "M4A1-S | Decimator (Field-Tested)",
        orderBestUsd: 1.2,
        targetPriceUsd: 1.21,
      },
    ],
  ]);

  const managedTargets = [
    {
      TargetID: "target-1",
      Title: "M4A1-S | Decimator (Field-Tested)",
      Amount: "1",
      Price: {
        Currency: "USD",
        Amount: 1.15,
      },
    },
  ];

  const actions = planManagedUpdates({
    managedTargets,
    opportunitiesByTitle,
    strategy: baseStrategy,
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, "replace");
  assert.equal(actions[0].reason, "outbid");
  assert.equal(actions[0].newPriceUsd, 1.21);
});

test("planNewTargets respects budget", () => {
  const opportunities = [
    {
      title: "Item A",
      targetPriceUsd: 2,
      score: 12,
    },
    {
      title: "Item B",
      targetPriceUsd: 3,
      score: 10,
    },
    {
      title: "Item C",
      targetPriceUsd: 1.5,
      score: 9,
    },
  ];

  const plans = planNewTargets({
    opportunities,
    managedTitles: [],
    strategy: {
      ...baseStrategy,
      newTargetsPerCycle: 10,
      maxAmountPerTarget: 1,
    },
    availableBudgetUsd: 4.1,
  });

  assert.equal(plans.length, 2);
  assert.equal(plans[0].title, "Item A");
  assert.equal(plans[1].title, "Item C");
});
