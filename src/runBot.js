import { DMarketTargetBot } from "./bot.js";
import { logger } from "./logger.js";

async function start() {
  const bot = new DMarketTargetBot();
  await bot.startAutoUpdate();

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

start().catch((error) => {
  logger.error("Auto mode startup failed", {
    message: error.message,
    stack: error.stack,
  });
  process.exit(1);
});
