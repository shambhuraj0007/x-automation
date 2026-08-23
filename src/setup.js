/**
 * src/setup.js
 * One-time setup script — discovers your Buffer Organization ID and Channel ID.
 *
 * Run this ONCE after configuring your API key:
 *   node src/setup.js
 *
 * It will print the exact values to paste into your .env file.
 */

'use strict';

require('dotenv').config();

async function main() {
  if (!process.env.BUFFER_ACCESS_TOKEN || process.env.BUFFER_ACCESS_TOKEN.startsWith('your_')) {
    console.error('\n❌ BUFFER_ACCESS_TOKEN is not set.');
    console.error('  1. Go to https://publish.buffer.com/settings/api');
    console.error('  2. Copy your API Key');
    console.error('  3. Add it to .env as: BUFFER_ACCESS_TOKEN=<your_key>');
    console.error('  (Note: this is a NEW API key, not the old OAuth token)\n');
    process.exit(1);
  }

  // Temporarily set a dummy logger level to suppress noise
  process.env.LOG_LEVEL = 'debug';

  const { discoverIds } = require('./buffer');

  console.log('\n🔍 Discovering your Buffer organization and channel IDs...\n');

  try {
    await discoverIds();
    console.log('\n✅ Copy the values above into your .env file, then run: node index.js\n');
  } catch (err) {
    console.error(`\n❌ Failed: ${err.message}`);
    console.error('Make sure your BUFFER_ACCESS_TOKEN is a valid Buffer API key from:');
    console.error('  https://publish.buffer.com/settings/api\n');
    process.exit(1);
  }
}

main();
