/**
 * src/scheduler.js
 * Core queue monitoring and refill logic.
 *
 * Implements:
 *  1. 6-hour cron scheduler
 *     → triggers refill when posts ≤ QUEUE_SOFT_THRESHOLD (default: 3)
 *  2. Startup queue check
 *     → to ensure initial population of the buffer
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



/**
 * Start a cron job that runs every 6 hours as a safety net.
 * Refills if posts ≤ QUEUE_SOFT_THRESHOLD.
 */
function startFallbackCron() {
  const softThreshold = parseInt(process.env.QUEUE_SOFT_THRESHOLD || '3', 10);

  logger.info(`Scheduler: starting 6-hour fallback cron (soft threshold ≤${softThreshold})`);

  // Every 6 hours: 0 */6 * * *
  const task = cron.schedule('0 */6 * * *', () => {
    logger.info('Scheduler [6hr-cron]: ⏰ Running scheduled health check...');
    checkAndRefill({ threshold: softThreshold, reason: '6hr-cron' });
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

module.exports = { startFallbackCron, runStartupCheck, checkAndRefill };
