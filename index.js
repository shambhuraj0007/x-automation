/**
 * index.js — Twitter Post Scheduler Dashboard
 *
 * Entry point. Starts an Express server that:
 *  1. Serves the web dashboard (public/)
 *  2. Exposes API routes for scheduling posts to Buffer
 *  3. Runs a 6-hour auto-fill cron to keep Buffer at 10 posts
 *
 * Usage:
 *   node index.js              → start the dashboard + auto-fill
 *   DRY_RUN=true node index.js → dry run (no real API calls to Buffer)
 */

'use strict';

// ── Load environment variables ──────────────────────────────────────────────
require('dotenv').config();

const express = require('express');
const path = require('path');
const logger = require('./src/logger');
const apiRouter = require('./src/api');
const { startAutoFillCron, autoFillQueue } = require('./src/autoFill');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ──────────────────────────────────────────────────────────────
app.use('/api', apiRouter);

// ── Startup banner ──────────────────────────────────────────────────────────
function printBanner() {
  const dryRun = process.env.DRY_RUN === 'true';
  logger.info('═══════════════════════════════════════════════════');
  logger.info('  🐦 Post Scheduler Dashboard — Starting Up');
  logger.info(`  Port       : ${PORT}`);
  logger.info(`  Spacing    : ${process.env.MIN_SPACING_MINUTES || 60}–${process.env.MAX_SPACING_MINUTES || 90} min`);
  logger.info(`  Buffer max : 10 posts`);
  logger.info(`  Blackout   : 2:00 AM – 6:00 AM (no posting)`);
  logger.info(`  Auto-fill  : every 6 hours`);
  logger.info(`  Mode       : ${dryRun ? '🟡 DRY RUN (no real Buffer calls)' : '🟢 LIVE'}`);
  logger.info('═══════════════════════════════════════════════════');
}

// ── Environment validation ──────────────────────────────────────────────────
function validateEnv() {
  const required = ['BUFFER_ACCESS_TOKEN', 'BUFFER_CHANNEL_ID'];
  const missing = required.filter(key => !process.env[key] || process.env[key].startsWith('your_'));

  if (missing.length > 0) {
    logger.error(`Missing or placeholder environment variables: ${missing.join(', ')}`);
    logger.error('Please fill in your Buffer API keys in .env');
    process.exit(1);
  }
}

// ── Graceful shutdown ───────────────────────────────────────────────────────
function setupShutdownHandlers(server, cronTask) {
  const shutdown = (signal) => {
    logger.info(`\nReceived ${signal} — shutting down gracefully...`);
    if (cronTask) cronTask.stop();
    server.close(() => {
      logger.info('Post Scheduler Dashboard stopped. Goodbye! 👋');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err.message}`, err);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled promise rejection: ${reason}`);
  });
}

// ── Start ───────────────────────────────────────────────────────────────────
printBanner();

if (process.env.DRY_RUN !== 'true') {
  validateEnv();
} else {
  logger.warn('DRY RUN mode: skipping environment validation');
}

// Start Express server
const server = app.listen(PORT, () => {
  logger.info(`✅ Dashboard is running at http://localhost:${PORT}`);
  logger.info(`📋 Logs are saved to: ${path.join(process.cwd(), 'logs')}`);
});

// Start 4-hour auto-fill cron
const cronTask = startAutoFillCron();

// Run an immediate auto-fill check on startup (in case queue drained while offline)
autoFillQueue().catch(err => {
  logger.warn(`Startup auto-fill check failed: ${err.message}`);
});

setupShutdownHandlers(server, cronTask);