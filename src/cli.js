import fs from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { DMarketTargetBot } from "./bot.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { ensureParentDirectory, roundUsd } from "./utils.js";

const DEFAULT_TITLES_PATH = path.resolve(process.cwd(), "data/market-titles.txt");
const DEFAULT_ANALYSIS_PATH = config.bot.analysisOutputPath;
const OPTION1_MIN_OFFER_USD = 20;
const OPTION1_MIN_MONTHLY_SALES = 10;

function resolveUserPath(userInput, fallbackAbsolutePath) {
  const value = userInput.trim();
  if (!value) {
    return fallbackAbsolutePath;
  }

  if (path.isAbsolute(value)) {
    return value;
  }

  return path.resolve(process.cwd(), value);
}

async function saveTitlesToFile(filePath, titles) {
  const uniqueSortedTitles = [...new Set(titles.map((title) => title.trim()))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  await ensureParentDirectory(filePath);
  await fs.writeFile(filePath, `${uniqueSortedTitles.join("\n")}\n`, "utf8");
  return uniqueSortedTitles;
}

async function loadTitlesFromFile(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return [...new Set(content.split(/\r?\n/).map((line) => line.trim()))].filter(
    Boolean,
  );
}

function printOpportunitiesTable(opportunities, limit = 50) {
  const rows = opportunities.slice(0, limit).map((entry, index) => ({
    "#": index + 1,
    title: entry.title,
    orderPriceUsd: roundUsd(entry.orderBestUsd),
    targetPriceUsd: roundUsd(entry.targetPriceUsd),
    expectedSellUsd: roundUsd(entry.expectedSellUsd),
    profitUsd: roundUsd(entry.profitUsd),
    roiPct: roundUsd(entry.roiPct),
    monthlySales: entry.monthlySales ?? "-",
    offers: entry.offerCount,
    orders: entry.orderCount,
  }));

  if (rows.length === 0) {
    // eslint-disable-next-line no-console
    console.log("Нет подходящих прибыльных вещей по текущему алгоритму.");
    return;
  }

  // eslint-disable-next-line no-console
  console.table(rows);
}

function toAnalysisRow(entry) {
  const maxTargetUsd = roundUsd(
    entry.maxTargetUsd ?? entry.targetPriceUsd ?? entry.minOfferUsd ?? 0,
  );
  const minOfferUsd = roundUsd(entry.minOfferUsd ?? entry.offerBestUsd ?? 0);
  const edgePct = Number.isFinite(Number(entry.edgePct))
    ? roundUsd(Number(entry.edgePct))
    : Number.isFinite(Number(entry.roiPct))
      ? roundUsd(Number(entry.roiPct))
      : minOfferUsd > 0
        ? roundUsd(((maxTargetUsd - minOfferUsd) / minOfferUsd) * 100)
        : 0;

  return {
    title: entry.title,
    maxTargetUsd,
    minOfferUsd,
    edgePct,
    monthlySales: entry.monthlySales ?? 0,
  };
}

function formatAlignedAnalysisLines(rows) {
  if (rows.length === 0) {
    return [];
  }

  const titleWidth = Math.max(
    "Название".length,
    ...rows.map((row) => row.title.length),
  );
  const targetWidth = Math.max(
    "Max target".length,
    ...rows.map((row) => `$${row.maxTargetUsd.toFixed(2)}`.length),
  );
  const offerWidth = Math.max(
    "Min offer".length,
    ...rows.map((row) => `$${row.minOfferUsd.toFixed(2)}`.length),
  );
  const edgeWidth = Math.max(
    "Выгода".length,
    ...rows.map((row) => `${row.edgePct.toFixed(2)}%`.length),
  );

  const header =
    `${"Название".padEnd(titleWidth)} | ` +
    `${"Max target".padStart(targetWidth)} | ` +
    `${"Min offer".padStart(offerWidth)} | ` +
    `${"Выгода".padStart(edgeWidth)}`;
  const separator = "-".repeat(header.length);

  const lines = rows.map((row) => {
    const target = `$${row.maxTargetUsd.toFixed(2)}`;
    const offer = `$${row.minOfferUsd.toFixed(2)}`;
    const edge = `${row.edgePct.toFixed(2)}%`;
    return (
      `${row.title.padEnd(titleWidth)} | ` +
      `${target.padStart(targetWidth)} | ` +
      `${offer.padStart(offerWidth)} | ` +
      `${edge.padStart(edgeWidth)}`
    );
  });

  return [header, separator, ...lines];
}

function printAnalysisPreview(rows, limit = 50) {
  const previewRows = rows.slice(0, limit);
  if (previewRows.length === 0) {
    // eslint-disable-next-line no-console
    console.log("Нет подходящих вещей после фильтров.");
    return;
  }

  const lines = formatAlignedAnalysisLines(previewRows);
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}

function printMenu() {
  // eslint-disable-next-line no-console
  console.log(`
================ DMarket Bot Menu ================
1 - Скан всей площадки и запись названий в файл
2 - Авто-анализ ВСЕХ вещей из data/market-titles.txt (без фильтров) + отчет
3 - Выставление таргетов на самые выгодные вещи из файла
4 - Авто-обновление таргетов каждые 15 минут
5 - Диагностика + 1 вещь из market-titles.txt (target/order)
6 - Один полный цикл ребаланса прямо сейчас
0 - Выход
==================================================
`);
}

async function handleOptionScanTitles(rl, bot) {
  const fileInput = await rl.question(
    `Файл для названий [${DEFAULT_TITLES_PATH}]: `,
  );
  const pagesInput = await rl.question(
    `Сколько страниц сканировать [${config.strategy.scanPages}]: `,
  );
  const pageSizeInput = await rl.question(
    `Размер страницы [${config.strategy.pageSize}]: `,
  );

  const titlesFilePath = resolveUserPath(fileInput, DEFAULT_TITLES_PATH);
  const maxPages = pagesInput.trim()
    ? Number.parseInt(pagesInput.trim(), 10)
    : config.strategy.scanPages;
  const pageSize = pageSizeInput.trim()
    ? Number.parseInt(pageSizeInput.trim(), 10)
    : config.strategy.pageSize;

  if (!Number.isFinite(maxPages) || maxPages <= 0) {
    throw new Error("Количество страниц должно быть положительным числом.");
  }
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    throw new Error("Размер страницы должен быть положительным числом.");
  }

  // eslint-disable-next-line no-console
  console.log(
    `Старт сканирования: до ${maxPages} страниц, размер страницы ${pageSize}. Прогресс будет печататься каждые 10 страниц...`,
  );

  const titles = await bot.discoverTitlesFromMarket({
    maxPages,
    pageSize,
    progressEveryPages: 10,
    onProgress: ({ page, maxPages: total, titlesFound, hasNextPage }) => {
      // eslint-disable-next-line no-console
      console.log(
        `[scan] Страница ${page}/${total} | titles: ${titlesFound} | next: ${hasNextPage ? "yes" : "no"}`,
      );
    },
  });
  // eslint-disable-next-line no-console
  console.log(
    `Этап 2/3: расчёт цен для ${titles.length} titles (min offer / max target)...`,
  );
  const pricingRows = await bot.analyzeTitlesPricing(titles);
  const byMinOffer = pricingRows.filter(
    (entry) => entry.minOfferUsd >= OPTION1_MIN_OFFER_USD,
  );

  // eslint-disable-next-line no-console
  console.log(
    `Этап 3/3: фильтр по продажам >=${OPTION1_MIN_MONTHLY_SALES}/30д для ${byMinOffer.length} titles...`,
  );
  const bySales = await bot.filterOpportunitiesByMonthlySales(byMinOffer, {
    minSalesPerMonth: OPTION1_MIN_MONTHLY_SALES,
    concurrency: config.bot.analysisSalesConcurrency,
    progressEvery: 20,
    onProgress: ({ checkedCount, total, passed }) => {
      // eslint-disable-next-line no-console
      console.log(`[sales] Проверено ${checkedCount}/${total}, прошло ${passed}`);
    },
  });
  const filteredTitles = bySales.map((entry) => entry.title);
  const storedTitles = await saveTitlesToFile(titlesFilePath, filteredTitles);

  // eslint-disable-next-line no-console
  console.log(
    `Готово: найдено ${titles.length}, после price>=${OPTION1_MIN_OFFER_USD}$: ${byMinOffer.length}, после sales>=${OPTION1_MIN_MONTHLY_SALES}/30д: ${storedTitles.length}. Сохранено в ${titlesFilePath}`,
  );
}

async function handleOptionAnalyzeFromFile(bot) {
  const titlesFilePath = DEFAULT_TITLES_PATH;
  const outputPath = DEFAULT_ANALYSIS_PATH;
  const printLimit = 50;

  // eslint-disable-next-line no-console
  console.log(
    `Пункт 2: авто-анализ без ввода. Источник: ${titlesFilePath}, отчет: ${outputPath}`,
  );

  const titles = await loadTitlesFromFile(titlesFilePath);
  if (titles.length === 0) {
    // eslint-disable-next-line no-console
    console.log("Файл пустой, анализировать нечего.");
    return;
  }

  const pricingRows = await bot.analyzeTitlesPricing(titles);
  const analysisRows = pricingRows.map((entry) => toAnalysisRow(entry)).sort((a, b) => {
      if (b.edgePct !== a.edgePct) {
        return b.edgePct - a.edgePct;
      }

      if (b.maxTargetUsd !== a.maxTargetUsd) {
        return b.maxTargetUsd - a.maxTargetUsd;
      }

      return b.monthlySales - a.monthlySales;
    });

  const lines = formatAlignedAnalysisLines(analysisRows);
  await ensureParentDirectory(outputPath);
  const fileContent = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  await fs.writeFile(outputPath, fileContent, "utf8");

  // eslint-disable-next-line no-console
  console.log(
    `Проанализировано: ${titles.length}, в отчет попало: ${analysisRows.length}`,
  );
  printAnalysisPreview(analysisRows, printLimit);
  // eslint-disable-next-line no-console
  console.log(
    `Отчет сохранен: ${outputPath}. Формат: выровненный список (название | max target | min offer | выгода)`,
  );
}

async function handleOptionCreateTargets(rl, bot) {
  const fileInput = await rl.question(
    `Файл с названиями [${DEFAULT_TITLES_PATH}]: `,
  );
  const maxTargetsInput = await rl.question(
    `Сколько новых таргетов максимум [${config.strategy.newTargetsPerCycle}]: `,
  );
  const candidatesInput = await rl.question(
    "Сколько лучших кандидатов брать из анализа [100]: ",
  );

  const titlesFilePath = resolveUserPath(fileInput, DEFAULT_TITLES_PATH);
  const maxTargets = maxTargetsInput.trim()
    ? Number.parseInt(maxTargetsInput.trim(), 10)
    : config.strategy.newTargetsPerCycle;
  const candidateLimit = candidatesInput.trim()
    ? Number.parseInt(candidatesInput.trim(), 10)
    : 100;

  if (!Number.isFinite(maxTargets) || maxTargets <= 0) {
    throw new Error("Максимум таргетов должен быть положительным числом.");
  }
  if (!Number.isFinite(candidateLimit) || candidateLimit <= 0) {
    throw new Error("Лимит кандидатов должен быть положительным числом.");
  }

  const titles = await loadTitlesFromFile(titlesFilePath);
  const opportunities = await bot.analyzeTitles(titles);
  const selected = opportunities.slice(0, candidateLimit);

  const result = await bot.createTargetsForOpportunities(selected, {
    maxNewTargets: maxTargets,
  });

  // eslint-disable-next-line no-console
  console.log(
    `Создано (или запланировано в dry-run): ${result.createPlans.length} таргетов`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `Баланс USD: ${result.balanceUsd}, занято: ${result.committedUsd}, доступно: ${result.availableBudgetUsd}`,
  );
  printOpportunitiesTable(result.createPlans.map((plan) => plan.metrics), 20);
}

async function handleOptionDiagnostics(bot) {
  const status = await bot.getStatusSummary();
  const scanTitles = await bot.discoverTitlesFromMarket({ maxPages: 1, pageSize: 10 });

  // eslint-disable-next-line no-console
  console.log("=== Диагностика ===");
  // eslint-disable-next-line no-console
  console.log(`Game ID: ${status.gameId}`);
  // eslint-disable-next-line no-console
  console.log(`Currency: ${status.currency}`);
  // eslint-disable-next-line no-console
  console.log(`Dry run: ${status.dryRun}`);
  // eslint-disable-next-line no-console
  console.log(`Balance USD: ${status.balanceUsd}`);
  // eslint-disable-next-line no-console
  console.log(`Active targets total: ${status.activeTargetsTotal}`);
  // eslint-disable-next-line no-console
  console.log(`Managed targets total: ${status.managedTargetsTotal}`);
  // eslint-disable-next-line no-console
  console.log(`Market connectivity probe titles (first page): ${scanTitles.length}`);

  // eslint-disable-next-line no-console
  console.log("\n=== Проверка одной вещи из market-titles.txt ===");
  let titles = [];
  try {
    titles = await loadTitlesFromFile(DEFAULT_TITLES_PATH);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  if (titles.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      `Файл ${DEFAULT_TITLES_PATH} пустой или не найден. Сначала выполните пункт 1.`,
    );
    return;
  }

  const title = titles[0];
  const rawAggregatedResponse = await bot.client.getAggregatedPrices({
    titles: [title],
    limit: 1,
    offset: 0,
  });
  const rawTargetsByTitleResponse = await bot.client
    .getTargetsByTitle({
      gameId: config.bot.gameId,
      title,
    })
    .catch((error) => ({
      __error: {
        message: error.message,
        status: error.status,
        payload: error.payload,
      },
    }));
  const pricing = await bot.analyzeTitlesPricing([title]);
  if (pricing.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`Не удалось получить цены для: ${title}`);
    // eslint-disable-next-line no-console
    console.log("RAW API response:");
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(rawAggregatedResponse, null, 2));
    // eslint-disable-next-line no-console
    console.log("RAW targets-by-title response:");
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(rawTargetsByTitleResponse, null, 2));
    return;
  }

  const item = pricing[0];
  // eslint-disable-next-line no-console
  console.log("RAW API response (/price-aggregator/v1/aggregated-prices):");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(rawAggregatedResponse, null, 2));
  // eslint-disable-next-line no-console
  console.log(
    "RAW API response (/marketplace-api/v1/targets-by-title/{game_id}/{title}):",
  );
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(rawTargetsByTitleResponse, null, 2));
  // eslint-disable-next-line no-console
  console.log("RAW parsed pricing object:");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(item, null, 2));
  // eslint-disable-next-line no-console
  console.log(`Title: ${item.title}`);
  // eslint-disable-next-line no-console
  console.log(`Target max: $${roundUsd(item.maxTargetUsd).toFixed(2)}`);
  // eslint-disable-next-line no-console
  console.log(`Target min: $${roundUsd(item.minTargetUsd ?? item.maxTargetUsd).toFixed(2)}`);
  // eslint-disable-next-line no-console
  console.log(`Order price: $${roundUsd(item.minOfferUsd).toFixed(2)}`);
  // eslint-disable-next-line no-console
  console.log(
    `Edge: ${roundUsd(
      ((item.maxTargetUsd - item.minOfferUsd) / item.minOfferUsd) * 100,
    ).toFixed(2)}%`,
  );
  // eslint-disable-next-line no-console
  console.log(`ROI: ${roundUsd(item.roiPct).toFixed(2)}%`);
}

async function startAutoMode(bot) {
  await bot.startAutoUpdate();
  // eslint-disable-next-line no-console
  console.log(
    `Авто-режим запущен. Обновление каждые ${config.bot.intervalMinutes} минут. Нажмите Ctrl+C для остановки.`,
  );

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

  await new Promise(() => {});
}

async function menuLoop() {
  const bot = new DMarketTargetBot();
  await bot.initialize();

  const rl = createInterface({ input, output });

  try {
    while (true) {
      printMenu();
      const choice = (await rl.question("Выберите пункт: ")).trim();

      try {
        if (choice === "0") {
          // eslint-disable-next-line no-console
          console.log("Выход.");
          break;
        }

        if (choice === "1") {
          await handleOptionScanTitles(rl, bot);
        } else if (choice === "2") {
          await handleOptionAnalyzeFromFile(bot);
        } else if (choice === "3") {
          await handleOptionCreateTargets(rl, bot);
        } else if (choice === "4") {
          rl.close();
          await startAutoMode(bot);
          return;
        } else if (choice === "5") {
          await handleOptionDiagnostics(bot);
        } else if (choice === "6") {
          await bot.runCycleSafe();
          // eslint-disable-next-line no-console
          console.log("Один цикл выполнен.");
        } else {
          // eslint-disable-next-line no-console
          console.log("Неизвестный пункт меню.");
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`Ошибка: ${error.message}`);
      }
    }
  } finally {
    rl.close();
    bot.stop();
    await bot.stateStore.save().catch(() => {});
  }
}

menuLoop().catch((error) => {
  logger.error("CLI startup failed", {
    message: error.message,
    stack: error.stack,
  });
  process.exit(1);
});
