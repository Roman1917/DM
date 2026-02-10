const nacl = require("tweetnacl");

const { buildQuery, fromHex, sleep, toHex } = require("./utils");

function buildSigningKey(secretKeyHex) {
  const raw = fromHex(secretKeyHex);

  if (raw.length === 64) {
    return raw;
  }

  if (raw.length === 32) {
    return nacl.sign.keyPair.fromSeed(raw).secretKey;
  }

  throw new Error(
    "DMARKET_SECRET_KEY must be a hex string of 32-byte seed (64 chars) or 64-byte secret key (128 chars).",
  );
}

class DMarketClient {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.signingKey = buildSigningKey(config.secretKey);
  }

  buildSignature({ method, pathWithQuery, bodyString, timestamp }) {
    const payload = `${method.toUpperCase()}${pathWithQuery}${bodyString}${timestamp}`;
    const payloadBytes = Buffer.from(payload, "utf8");
    const signature = nacl.sign.detached(payloadBytes, this.signingKey);

    return toHex(signature);
  }

  async request({ method, path, query, body }) {
    const queryString = buildQuery(query);
    const pathWithQuery = queryString ? `${path}?${queryString}` : path;
    const url = `${this.config.baseUrl}${pathWithQuery}`;
    const bodyString = body ? JSON.stringify(body) : "";
    const timestamp = `${Math.floor(Date.now() / 1000)}`;
    const signature = this.buildSignature({
      method,
      pathWithQuery,
      bodyString,
      timestamp,
    });

    const headers = {
      Accept: "application/json",
      "X-Api-Key": this.config.apiKey,
      "X-Sign-Date": timestamp,
      "X-Request-Sign": signature,
    };

    if (this.config.authorization) {
      headers.Authorization = this.config.authorization;
    }

    if (body) {
      headers["Content-Type"] = "application/json";
    }

    let attempt = 0;
    const maxAttempts = Math.max(1, this.config.maxRetries + 1);
    let lastError = null;

    while (attempt < maxAttempts) {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.config.requestTimeoutMs,
      );

      try {
        const response = await fetch(url, {
          method,
          headers,
          body: bodyString || undefined,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const contentType = response.headers.get("content-type") || "";
        const isJson = contentType.includes("application/json");
        const payload = isJson
          ? await response.json()
          : await response.text().catch(() => "");

        if (!response.ok) {
          const retriable = response.status === 429 || response.status >= 500;
          const error = new Error(
            `DMarket API request failed with status ${response.status}`,
          );
          error.status = response.status;
          error.payload = payload;

          if (retriable && attempt < maxAttempts - 1) {
            const delayMs = 500 * 2 ** attempt;
            this.logger.warn("Retrying DMarket API request", {
              method,
              pathWithQuery,
              attempt: attempt + 1,
              delayMs,
              status: response.status,
            });
            await sleep(delayMs);
            attempt += 1;
            continue;
          }

          throw error;
        }

        return payload;
      } catch (error) {
        clearTimeout(timeoutId);
        lastError = error;
        const isAbort = error.name === "AbortError";
        const isRetriableNetworkError = isAbort || !("status" in error);

        if (!isRetriableNetworkError || attempt >= maxAttempts - 1) {
          break;
        }

        const delayMs = 500 * 2 ** attempt;
        this.logger.warn("Retrying after network error", {
          method,
          pathWithQuery,
          attempt: attempt + 1,
          delayMs,
          reason: error.message,
        });
        await sleep(delayMs);
        attempt += 1;
      }
    }

    throw lastError || new Error("DMarket API request failed.");
  }

  async getBalance() {
    return this.request({
      method: "GET",
      path: "/account/v1/balance",
    });
  }

  async getMarketItems({ gameId, currency, limit = 100, cursor = "" }) {
    return this.request({
      method: "GET",
      path: "/exchange/v1/market/items",
      query: {
        gameId,
        currency,
        limit,
        cursor,
      },
    });
  }

  async getAggregatedPrices({ titles, limit, offset }) {
    return this.request({
      method: "GET",
      path: "/price-aggregator/v1/aggregated-prices",
      query: {
        Titles: titles,
        Limit: limit,
        Offset: offset,
      },
    });
  }

  async getUserTargets({ gameId, cursor = "", limit = 100 }) {
    return this.request({
      method: "GET",
      path: "/marketplace-api/v1/user-targets",
      query: {
        GameID: gameId,
        Cursor: cursor,
        Limit: `${limit}`,
      },
    });
  }

  async getAllUserTargets({ gameId, pageLimit = 100 }) {
    const result = [];
    let cursor = "";
    let safetyCounter = 0;

    while (safetyCounter < 10_000) {
      const page = await this.getUserTargets({
        gameId,
        cursor,
        limit: pageLimit,
      });

      const items = page?.Items || [];
      result.push(...items);

      const nextCursor = page?.Cursor;
      if (!nextCursor || nextCursor === cursor) {
        break;
      }

      cursor = nextCursor;
      safetyCounter += 1;
    }

    return result;
  }

  async createTargets({ gameId, targets }) {
    return this.request({
      method: "POST",
      path: "/marketplace-api/v1/user-targets/create",
      body: {
        GameID: gameId,
        Targets: targets,
      },
    });
  }

  async deleteTargets({ targetIds }) {
    return this.request({
      method: "POST",
      path: "/marketplace-api/v1/user-targets/delete",
      body: {
        Targets: targetIds.map((targetId) => ({ TargetID: targetId })),
      },
    });
  }
}

module.exports = {
  DMarketClient,
};
