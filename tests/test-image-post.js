/**
 * tests/test-image-post.js
 * End-to-end test: generates 1 tweet with image and schedules it in Buffer.
 *
 * Usage:
 *   node tests/test-image-post.js
 */

'use strict';

require('dotenv').config();
const logger = require('../src/logger');
const { generateImage } = require('../src/imageGen');
const { generatePosts } = require('../src/gemini');
const { schedulePosts } = require('../src/buffer');
const fs = require('fs');
const path = require('path');

async function run() {
  logger.info('═══════════════════════════════════════════════════');
  logger.info('  🧪 End-to-End Image + Post Test');
  logger.info('═══════════════════════════════════════════════════');

  // ── STEP 1: Generate 1 tweet with image prompt from Gemini ─────────────────
  logger.info('\n📝 STEP 1: Generating 1 tweet via Gemini...');
  const posts = await generatePosts({ count: 1 });
  const post = posts[0];

  logger.info(`\n✅ Tweet text:\n"${post.text}"\n`);
  logger.info(`✅ Image prompt:\n"${post.imagePrompt}"\n`);

  if (!post.imagePrompt) {
    logger.warn('⚠️  No image prompt was generated — check prompt.js');
  }

  // ── STEP 2: Generate image via HuggingFace SDXL ────────────────────────────
  logger.info('🎨 STEP 2: Generating image via HuggingFace SDXL...');
  const imageUrl = await generateImage(post.imagePrompt || 'A futuristic AI brain, neon glow, cinematic');

  if (imageUrl) {
    logger.info(`\n✅ Image URL: ${imageUrl}`);

    // Check the file was actually saved locally
    const imagesDir = path.join(process.cwd(), 'data', 'images');
    const savedFiles = fs.readdirSync(imagesDir).filter(f => f.endsWith('.png'));
    logger.info(`✅ Files in data/images/: ${savedFiles.join(', ')}`);
  } else {
    logger.warn('⚠️  Image generation failed — will post text-only');
  }

  // ── STEP 3: Schedule the post in Buffer ────────────────────────────────────
  logger.info('\n📅 STEP 3: Scheduling post in Buffer...');

  const postWithImage = {
    text: post.text,
    imagePrompt: post.imagePrompt,
    imageUrl: imageUrl,  // Pre-resolved (could be null) — buffer.js won't re-generate
  };

  await schedulePosts([postWithImage]);

  logger.info('\n═══════════════════════════════════════════════════');
  logger.info('  ✅ Test complete! Check Buffer queue for the post.');
  logger.info('═══════════════════════════════════════════════════');
}

run().catch(err => {
  logger.error(`\n❌ Test FAILED: ${err.message}`);
  console.error(err);
  process.exit(1);
});
