import fs from "node:fs/promises";
import path from "node:path";

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

export function fromHex(hexString) {
  const normalized = hexString.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error("Hex string is invalid.");
  }

  return new Uint8Array(Buffer.from(normalized, "hex"));
}

export function buildQuery(params) {
  const pairs = [];

  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry === undefined || entry === null || entry === "") {
          continue;
        }

        pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(entry)}`);
      }
      continue;
    }

    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }

  return pairs.join("&");
}

export function parseNumber(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

export function toUsd(value, priceInCoins) {
  const amount = parseNumber(value);
  if (amount === null) {
    return null;
  }

  if (priceInCoins) {
    return amount / 100;
  }

  return amount;
}

export function roundUsd(value) {
  return Number(Number(value).toFixed(2));
}

export function maxTargetByProfitability({
  expectedSellUsd,
  saleCommissionPct,
  minProfitUsd,
  minRoiPct,
}) {
  const commissionMultiplier = 1 - saleCommissionPct / 100;
  const netSellUsd = expectedSellUsd * commissionMultiplier;

  const byAbsoluteProfit = netSellUsd - minProfitUsd;
  const byRoi = netSellUsd / (1 + minRoiPct / 100);

  return Math.min(byAbsoluteProfit, byRoi);
}

export function ensurePositiveNumber(value, fallback) {
  const parsed = parseNumber(value);
  if (parsed === null || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export function chunkArray(items, chunkSize) {
  const safeChunkSize = Math.max(1, Math.floor(chunkSize));
  const result = [];

  for (let i = 0; i < items.length; i += safeChunkSize) {
    result.push(items.slice(i, i + safeChunkSize));
  }

  return result;
}

export async function ensureParentDirectory(filePath) {
  const dirPath = path.dirname(filePath);
  await fs.mkdir(dirPath, { recursive: true });
}
