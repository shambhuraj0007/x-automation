/**
 * index.js — Twitter Automation Daemon
 *
 * Entry point. Loads config, validates environment, starts the scheduler.
 *
 * Usage:
 *   node index.js          → production
 *   DRY_RUN=true node index.js  → dry run (no real API calls to Buffer)
 */

'use strict';

// ── Load environment variables ──────────────────────────────────────────────
require('dotenv').config();

const logger = require('./src/logger');
const { startFallbackCron, runStartupCheck } = require('./src/scheduler');

// ── Startup banner ──────────────────────────────────────────────────────────
function printBanner() {
  const dryRun = process.env.DRY_RUN === 'true';
  logger.info('═══════════════════════════════════════════════════');
  logger.info('  🐦 Twitter Automation Daemon — Starting Up');
  logger.info(`  Niche    : ${process.env.TWEET_NICHE || '(not set)'}`);
  logger.info(`  Model    : ${process.env.GEMINI_MODEL || 'gemini-1.5-flash'}`);
  logger.info(`  Batch    : ${process.env.POSTS_PER_BATCH || 3} posts per refill`);
  logger.info(`  Spacing  : ${process.env.MIN_SPACING_MINUTES || 45}–${process.env.MAX_SPACING_MINUTES || 120} min`);
  logger.info(`  Threshold: refill when ≤ ${process.env.QUEUE_SOFT_THRESHOLD || 3} post`);
  logger.info(`  Mode     : ${dryRun ? '🟡 DRY RUN (no real Buffer calls)' : '🟢 LIVE'}`);
  logger.info('═══════════════════════════════════════════════════');
}

// ── Environment validation ──────────────────────────────────────────────────
function validateEnv() {
  const required = ['GEMINI_API_KEY', 'BUFFER_ACCESS_TOKEN', 'BUFFER_ORG_ID', 'BUFFER_CHANNEL_ID'];
  const missing = required.filter(key => !process.env[key] || process.env[key].startsWith('your_'));

  if (missing.length > 0) {
    logger.error(`Missing or placeholder environment variables: ${missing.join(', ')}`);
    logger.error('Please copy .env.example to .env and fill in your API keys.');
    process.exit(1);
  }

  if (!process.env.TWEET_NICHE) {
    logger.warn('TWEET_NICHE is not set — defaulting to "AI and technology"');
  }
}

// ── Graceful shutdown ───────────────────────────────────────────────────────
function setupShutdownHandlers(monitorHandle, cronTask) {
  const shutdown = (signal) => {
    logger.info(`\nReceived ${signal} — shutting down gracefully...`);
    if (cronTask) cronTask.stop();
    logger.info('Twitter Automation Daemon stopped. Goodbye! 👋');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err.message}`, err);
    // Don't exit — let the daemon keep running unless it's truly unrecoverable
  });

  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled promise rejection: ${reason}`);
  });
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  printBanner();

  // Skip validation in dry-run mode for easier testing
  if (process.env.DRY_RUN !== 'true') {
    validateEnv();
  } else {
    logger.warn('DRY RUN mode: skipping environment validation');
  }

  // 1. Startup check — fill queue immediately if needed
  await runStartupCheck();

  // 2. 4-hour fallback cron — safety net
  const cronTask = startFallbackCron();

  // 3. Register shutdown handlers
  setupShutdownHandlers(null, cronTask);

  logger.info('✅ Daemon is running. Press Ctrl+C to stop.');
  logger.info(`📋 Logs are saved to: ${require('path').join(process.cwd(), 'logs')}`);
}

main().catch((err) => {
  logger.error(`Fatal startup error: ${err.message}`, err);
  process.exit(1);
});
