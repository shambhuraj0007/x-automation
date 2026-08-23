'use strict';
require('dotenv').config();
const { checkAndRefill } = require('./src/scheduler');
const logger = require('./src/logger');

async function run() {
  logger.info('GitHub Actions: Starting one-off bot run...');
  // Force refill check using the soft threshold from env (defaults to 3)
  const softThreshold = parseInt(process.env.QUEUE_SOFT_THRESHOLD || '3', 10);
  await checkAndRefill({ threshold: softThreshold, reason: 'github-action' });
  logger.info('GitHub Actions: Run complete.');
}

run().catch(err => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
