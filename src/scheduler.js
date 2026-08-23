/**
 * src/scheduler.js
 * Core queue monitoring and refill logic.
 *
 * Implements:
 *  1. Real-time queue monitor (polls every QUEUE_POLL_INTERVAL_MINUTES)
 *     → triggers immediate refill when posts ≤ QUEUE_REFILL_THRESHOLD (default: 1)
 *  2. 4-hour fallback cron as a safety net
 *     → triggers refill when posts ≤ QUEUE_SOFT_THRESHOLD (default: 3)
 */

'use strict';

const cron = require('node-cron');
const logger = require('./logger');
const { getQueueCount, schedulePosts } = require('./buffer');
const { generatePosts } = require('./gemini');

// Guard: prevent concurrent refill runs
let isRefilling = false;

// ── Core refill logic ───────────────────────────────────────────────────────

/**
 * Check the queue and refill if the count is at or below the threshold.
 *
 * @param {Object} opts
 * @param {number} opts.threshold  - Refill when count ≤ this
 * @param {string} opts.reason     - Label for logging
 * @returns {Promise<void>}
 */
async function checkAndRefill({ threshold, reason }) {
  if (isRefilling) {
    logger.debug(`Scheduler [${reason}]: refill already in progress — skipping`);
    return;
  }

  try {
    const count = await getQueueCount();
    logger.info(`Scheduler [${reason}]: queue has ${count} scheduled post(s) (threshold: ≤${threshold})`);

    if (count <= threshold) {
      await _doRefill(reason);
    } else {
      logger.info(`Scheduler [${reason}]: queue healthy — no refill needed`);
    }
  } catch (err) {
    logger.error(`Scheduler [${reason}]: check failed — ${err.message}`, err);
  }
}

/**
 * Unconditionally generate and schedule a fresh batch of posts.
 * @private
 */
async function _doRefill(reason) {
  isRefilling = true;
  const batchSize = parseInt(process.env.POSTS_PER_BATCH || '3', 10);

  try {
    logger.info(`Scheduler [${reason}]: 🚀 Refilling queue with ${batchSize} new posts...`);

    const posts = await generatePosts({ count: batchSize });
    await schedulePosts(posts);

    logger.info(`Scheduler [${reason}]: ✅ Refill complete — ${posts.length} post(s) added to Buffer`);
  } catch (err) {
    logger.error(`Scheduler [${reason}]: ❌ Refill failed — ${err.message}`, err);
  } finally {
    isRefilling = false;
  }
}

// ── Real-time queue monitor ─────────────────────────────────────────────────

/**
 * Start polling the Buffer queue every N minutes.
 * Triggers an immediate refill when posts drop to ≤ QUEUE_REFILL_THRESHOLD.
 */
function startQueueMonitor() {
  const pollMins = parseInt(process.env.QUEUE_POLL_INTERVAL_MINUTES || '10', 10);
  const threshold = parseInt(process.env.QUEUE_REFILL_THRESHOLD || '1', 10);

  logger.info(`Scheduler: starting queue monitor (poll every ${pollMins} min, threshold ≤${threshold})`);

  // Use setInterval rather than cron so we can use sub-minute values in tests
  const intervalMs = pollMins * 60 * 1000;
  const handle = setInterval(() => {
    checkAndRefill({ threshold, reason: 'queue-monitor' });
  }, intervalMs);

  // Keep Node.js alive but don't block clean shutdown
  handle.unref();
  return handle;
}

// ── 4-hour fallback cron ────────────────────────────────────────────────────

/**
 * Start a cron job that runs every 4 hours as a safety net.
 * Refills if posts ≤ QUEUE_SOFT_THRESHOLD.
 */
function startFallbackCron() {
  const softThreshold = parseInt(process.env.QUEUE_SOFT_THRESHOLD || '3', 10);

  logger.info(`Scheduler: starting 4-hour fallback cron (soft threshold ≤${softThreshold})`);

  // Every 4 hours: 0 */4 * * *
  const task = cron.schedule('0 */4 * * *', () => {
    logger.info('Scheduler [4hr-cron]: ⏰ Running scheduled health check...');
    checkAndRefill({ threshold: softThreshold, reason: '4hr-cron' });
  }, { scheduled: true, timezone: 'UTC' });

  return task;
}

// ── Startup check ───────────────────────────────────────────────────────────

/**
 * Run an immediate check on startup so the queue is filled before any timer fires.
 */
async function runStartupCheck() {
  const softThreshold = parseInt(process.env.QUEUE_SOFT_THRESHOLD || '3', 10);
  logger.info('Scheduler: running startup queue check...');
  await checkAndRefill({ threshold: softThreshold, reason: 'startup' });
}

module.exports = { startQueueMonitor, startFallbackCron, runStartupCheck, checkAndRefill };
