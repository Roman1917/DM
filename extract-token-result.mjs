import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const HELP = `
Usage:
  node extract-token-result.mjs --input <input.txt> --output <output.json> --mint <token_mint> [options]

Options:
  --at <timestamp>      Exact timestamp in format: YYYY-MM-DD HH:mm:ss.SSS
  --from <timestamp>    Start timestamp (inclusive)
  --to <timestamp>      End timestamp (inclusive)
  --flat-txs            Also place unique txs in top-level "txs" array
  --help                Show this help

Examples:
  node extract-token-result.mjs \\
    --input logs.txt \\
    --output filtered.json \\
    --mint LWPihkg8SWDiAzG5TXAsgQuJeSZ3cXem1VStNX8PLAY \\
    --at "2026-02-26 20:44:09.480"

  node extract-token-result.mjs \\
    --input logs.txt \\
    --output filtered.json \\
    --mint LWPihkg8SWDiAzG5TXAsgQuJeSZ3cXem1VStNX8PLAY \\
    --from "2026-02-26 20:44:09.480" \\
    --to "2026-02-26 20:45:00.000" \\
    --flat-txs
`;

function parseArgs(argv) {
  const args = {
    input: "",
    output: "",
    mint: "",
    at: "",
    from: "",
    to: "",
    flatTxs: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    if (token === "--help") {
      args.help = true;
      continue;
    }

    if (token === "--flat-txs") {
      args.flatTxs = true;
      continue;
    }

    if (
      token === "--input" ||
      token === "--output" ||
      token === "--mint" ||
      token === "--at" ||
      token === "--from" ||
      token === "--to"
    ) {
      if (!next || next.startsWith("--")) {
        throw new Error(`Missing value for ${token}`);
      }

      const key = token.slice(2);
      args[key] = next;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (args.help) {
    return args;
  }

  if (!args.input) {
    throw new Error("Missing required argument: --input");
  }

  if (!args.output) {
    throw new Error("Missing required argument: --output");
  }

  if (!args.mint) {
    throw new Error("Missing required argument: --mint");
  }

  if (args.at && (args.from || args.to)) {
    throw new Error("Use either --at or --from/--to, not both");
  }

  return args;
}

function isTimestampInRange(timestamp, options) {
  if (options.at) {
    return timestamp === options.at;
  }

  if (options.from && timestamp < options.from) {
    return false;
  }

  if (options.to && timestamp > options.to) {
    return false;
  }

  return true;
}

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === "\\") {
        escaped = true;
        continue;
      }

      if (ch === '"') {
        inString = false;
      }

      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth += 1;
      continue;
    }

    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function extractTokenResultBlocks(content) {
  const blocks = [];
  const headerRegex =
    /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]\s*TokenResult\s*\{/g;

  let match;
  while ((match = headerRegex.exec(content)) !== null) {
    const timestamp = match[1];
    const braceStart = content.indexOf("{", match.index);

    if (braceStart === -1) {
      continue;
    }

    const braceEnd = findMatchingBrace(content, braceStart);
    if (braceEnd === -1) {
      throw new Error(`Cannot find closing brace for TokenResult at ${timestamp}`);
    }

    const rawObject = content.slice(braceStart, braceEnd + 1);
    blocks.push({ timestamp, rawObject });

    // Move regex cursor to the end of current block
    headerRegex.lastIndex = braceEnd + 1;
  }

  return blocks;
}

function toJsonString(rawObject) {
  const withoutTypes = rawObject.replace(/\b[A-Za-z_][A-Za-z0-9_]*\s*\{/g, "{");
  const withQuotedKeys = withoutTypes.replace(
    /([{\[,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g,
    '$1"$2"$3',
  );
  const withQuotedEnumLikeValues = withQuotedKeys.replace(
    /(:\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*[,}\]])/g,
    (full, prefix, value, suffix) => {
      if (value === "true" || value === "false" || value === "null") {
        return full;
      }
      return `${prefix}"${value}"${suffix}`;
    },
  );
  const noTrailingCommas = withQuotedEnumLikeValues.replace(/,\s*([}\]])/g, "$1");
  return noTrailingCommas;
}

function parseTokenResult(rawObject, timestamp) {
  const jsonLike = toJsonString(rawObject);
  try {
    return JSON.parse(jsonLike);
  } catch (error) {
    throw new Error(
      `Failed to parse TokenResult at ${timestamp}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function normalizeTx(tx) {
  return {
    url: tx.url ?? null,
    profit: tx.profit ?? null,
    fee: tx.fee ?? null,
    payer: tx.payer ?? null,
    slot: tx.slot ?? null,
    is_whitelisted: tx.is_whitelisted ?? null,
  };
}

function normalizeSnapshot(timestamp, mintInfo) {
  return {
    timestamp,
    mint: mintInfo.mint ?? null,
    total_profit: mintInfo.total_profit ?? null,
    total_volume: mintInfo.total_volume ?? null,
    roi: mintInfo.roi ?? null,
    arbs_count: mintInfo.arbs_count ?? null,
    total_fee: mintInfo.total_fee ?? null,
    total_wsol_liquidity: mintInfo.total_wsol_liquidity ?? null,
    txs: Array.isArray(mintInfo.txs) ? mintInfo.txs.map(normalizeTx) : [],
  };
}

function uniqueTxsFromSnapshots(snapshots) {
  const map = new Map();

  for (const snapshot of snapshots) {
    for (const tx of snapshot.txs) {
      const key = tx.url ?? `${tx.slot}-${tx.payer}-${tx.profit}-${tx.fee}`;
      if (!map.has(key)) {
        map.set(key, tx);
      }
    }
  }

  return Array.from(map.values());
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(HELP);
    process.exit(1);
  }

  if (args.help) {
    console.log(HELP);
    return;
  }

  const rawText = await readFile(args.input, "utf8");
  const blocks = extractTokenResultBlocks(rawText);

  const snapshots = [];
  for (const block of blocks) {
    if (!isTimestampInRange(block.timestamp, args)) {
      continue;
    }

    const parsed = parseTokenResult(block.rawObject, block.timestamp);
    const mintInfoList = Array.isArray(parsed.arb_mint_info) ? parsed.arb_mint_info : [];

    for (const mintInfo of mintInfoList) {
      if (mintInfo?.mint !== args.mint) {
        continue;
      }
      snapshots.push(normalizeSnapshot(block.timestamp, mintInfo));
    }
  }

  const output = {
    token: args.mint,
    filter: {
      at: args.at || null,
      from: args.from || null,
      to: args.to || null,
    },
    snapshots_count: snapshots.length,
    snapshots,
  };

  if (args.flatTxs) {
    output.txs = uniqueTxsFromSnapshots(snapshots);
  }

  await writeFile(args.output, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  console.log(`Done. Saved ${snapshots.length} snapshot(s) to ${args.output}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
