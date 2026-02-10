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

function printMenu() {
  // eslint-disable-next-line no-console
  console.log(`
================ DMarket Bot Menu ================
1 - Скан всей площадки и запись названий в файл
2 - Анализ из файла + отчет (title-target-order-ROI, фильтры >=10$/>=10 продаж/мес)
3 - Выставление таргетов на самые выгодные вещи из файла
4 - Авто-обновление таргетов каждые 15 минут
5 - Диагностика API и состояния
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

  const titles = await bot.discoverTitlesFromMarket({ maxPages, pageSize });
  const storedTitles = await saveTitlesToFile(titlesFilePath, titles);

  // eslint-disable-next-line no-console
  console.log(
    `Готово: найдено ${titles.length} / сохранено ${storedTitles.length} titles в ${titlesFilePath}`,
  );
}

async function handleOptionAnalyzeFromFile(rl, bot) {
  const fileInput = await rl.question(
    `Файл с названиями [${DEFAULT_TITLES_PATH}]: `,
  );
  const limitInput = await rl.question("Сколько строк показать в таблице [50]: ");
  const outputFileInput = await rl.question(
    `Куда сохранить отчет [${DEFAULT_ANALYSIS_PATH}]: `,
  );

  const titlesFilePath = resolveUserPath(fileInput, DEFAULT_TITLES_PATH);
  const outputPath = resolveUserPath(outputFileInput, DEFAULT_ANALYSIS_PATH);
  const printLimit = limitInput.trim() ? Number.parseInt(limitInput.trim(), 10) : 50;

  if (!Number.isFinite(printLimit) || printLimit <= 0) {
    throw new Error("Лимит отображения должен быть положительным числом.");
  }

  const titles = await loadTitlesFromFile(titlesFilePath);
  if (titles.length === 0) {
    // eslint-disable-next-line no-console
    console.log("Файл пустой, анализировать нечего.");
    return;
  }

  const opportunities = await bot.analyzeTitles(titles);
  const byTargetPrice = opportunities.filter(
    (entry) => entry.targetPriceUsd >= config.bot.analysisMinTargetPriceUsd,
  );
  const filteredBySales = await bot.filterOpportunitiesByMonthlySales(
    byTargetPrice,
    {
      minSalesPerMonth: config.bot.analysisMinMonthlySales,
      concurrency: config.bot.analysisSalesConcurrency,
    },
  );
  const finalReport = [...filteredBySales].sort((a, b) => {
    if (b.roiPct !== a.roiPct) {
      return b.roiPct - a.roiPct;
    }
    return b.profitUsd - a.profitUsd;
  });

  const lines = finalReport.map(
    (entry) =>
      `${entry.title} - ${roundUsd(entry.targetPriceUsd).toFixed(2)}$ - ${roundUsd(
        entry.orderBestUsd,
      ).toFixed(2)}$ - ${roundUsd(entry.roiPct).toFixed(2)}%`,
  );
  await ensureParentDirectory(outputPath);
  await fs.writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");

  // eslint-disable-next-line no-console
  console.log(
    `Проанализировано: ${titles.length}, после фильтра target>=${config.bot.analysisMinTargetPriceUsd}$: ${byTargetPrice.length}, после фильтра продаж>=${config.bot.analysisMinMonthlySales}/мес: ${finalReport.length}`,
  );
  printOpportunitiesTable(finalReport, printLimit);
  // eslint-disable-next-line no-console
  console.log(
    `Отчет сохранен: ${outputPath}. Формат: название - цена таргета - цена ордера - процент выгоды`,
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
          await handleOptionAnalyzeFromFile(rl, bot);
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
