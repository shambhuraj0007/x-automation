/**
 * src/imageGen.js
 * AI image generation via Hugging Face SDXL.
 *
 * Flow:
 *   1. Call HF Inference API → stabilityai/stable-diffusion-xl-base-1.0
 *   2. Save image binary to data/images/YYYY-MM-DD-<random>.png
 *   3. Return a raw.githubusercontent.com URL so Buffer can embed it
 *
 * Required env vars:
 *   HF_API_KEY         - Hugging Face token (free at huggingface.co/settings/tokens)
 *   GITHUB_REPOSITORY  - Auto-set in GitHub Actions as "owner/repo"
 *                        Set manually in .env for local testing: e.g. "shambhuraj0007/x-automation"
 *   GITHUB_REF_NAME    - Branch name (auto-set in Actions, defaults to "main")
 */

'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pRetry = require('p-retry').default;
const logger = require('./logger');

const HF_MODEL = 'stabilityai/stable-diffusion-xl-base-1.0';
const HF_API_URL = `https://api-inference.huggingface.co/models/${HF_MODEL}`;
const IMAGES_DIR = path.join(process.cwd(), 'data', 'images');

// ── Setup ────────────────────────────────────────────────────────────────────

// Ensure the images directory exists
if (!fs.existsSync(IMAGES_DIR)) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  logger.info('imageGen: created data/images/ directory');
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate an image from a text prompt, save it to data/images/, and
 * return a raw.githubusercontent.com URL for Buffer to embed.
 *
 * @param {string} prompt  - The image generation prompt
 * @returns {Promise<string|null>}  - GitHub raw URL, or null on failure
 */
async function generateImage(prompt) {
  const hfKey = process.env.HF_API_KEY;
  const repo  = process.env.GITHUB_REPOSITORY;  // e.g. "shambhuraj0007/x-automation"
  const branch = process.env.GITHUB_REF_NAME || 'main';

  if (!hfKey) {
    logger.warn('imageGen: HF_API_KEY not set — skipping image generation');
    return null;
  }
  if (!repo) {
    logger.warn('imageGen: GITHUB_REPOSITORY not set — skipping image generation (set it in .env for local runs)');
    return null;
  }

  try {
    logger.info(`imageGen: generating SDXL image for: "${prompt.slice(0, 80)}..."`);

    let imageBuffer;
    try {
      imageBuffer = await pRetry(
        () => _callHuggingFace(prompt, hfKey),
        {
          retries: 3,
          minTimeout: 8000,
          maxTimeout: 30000,
          factor: 2,
          onFailedAttempt: (err) => {
            logger.warn(
              `imageGen: HF attempt ${err.attemptNumber} failed. ` +
              `${err.retriesLeft} retries left — ${err.message}`
            );
          },
        }
      );
    } catch (hfErr) {
      logger.warn(`imageGen: HuggingFace failed entirely (${hfErr.message}). Falling back to Pollinations...`);
      imageBuffer = await pRetry(
        () => _callPollinations(prompt),
        {
          retries: 2,
          minTimeout: 5000,
          factor: 2,
          onFailedAttempt: (err) => {
            logger.warn(`imageGen: Pollinations attempt ${err.attemptNumber} failed — ${err.message}`);
          }
        }
      );
    }

    // Save to disk
    const filename = _makeFilename();
    const filePath = path.join(IMAGES_DIR, filename);
    fs.writeFileSync(filePath, imageBuffer);
    logger.info(`imageGen: saved image → data/images/${filename}`);

    // Build the raw GitHub URL (will be valid once the commit step runs)
    const rawUrl = `https://raw.githubusercontent.com/${repo}/${branch}/data/images/${filename}`;
    logger.info(`imageGen: ✅ image URL → ${rawUrl}`);
    return rawUrl;

  } catch (err) {
    logger.error(`imageGen: failed to generate image (both HF and fallback failed) — ${err.message}`);
    return null; // Non-fatal: post goes out as text-only
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Call HuggingFace Inference API and return raw image Buffer.
 * @private
 */
async function _callHuggingFace(prompt, apiKey) {
  const response = await axios.post(
    HF_API_URL,
    {
      inputs: prompt,
      parameters: {
        width: 1024,
        height: 1024,
        num_inference_steps: 30,
        guidance_scale: 7.5,
      },
    },
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      responseType: 'arraybuffer',
      timeout: 120000, // SDXL can be slow on free tier
    }
  );

  // HF returns JSON (not image) when the model is still loading
  const contentType = response.headers['content-type'] || '';
  if (contentType.includes('application/json')) {
    const json = JSON.parse(Buffer.from(response.data).toString('utf8'));
    if (json.error) {
      const waitSecs = json.estimated_time ? Math.ceil(json.estimated_time) : 30;
      const isLoading = json.error.toLowerCase().includes('loading');
      throw new Error(isLoading
        ? `Model loading, estimated wait: ${waitSecs}s`
        : `HuggingFace API error: ${json.error}`
      );
    }
  }

  if (!contentType.includes('image/')) {
    throw new Error(`Unexpected content-type from HF: "${contentType}"`);
  }

  logger.debug(`imageGen: received ${response.data.byteLength} bytes from HuggingFace`);
  return Buffer.from(response.data);
}

/**
 * Generate a unique filename with the current date for easy age-based cleanup.
 * Format: YYYY-MM-DD-<8-char-random>.png
 * @private
 */
function _makeFilename() {
  const date = new Date().toISOString().slice(0, 10); // "2026-08-23"
  const rand = crypto.randomBytes(4).toString('hex'); // "a3f9c12b"
  return `${date}-${rand}.png`;
}

/**
 * Call Pollinations AI as a fallback and return raw image Buffer.
 * @private
 */
async function _callPollinations(prompt) {
  const encodedPrompt = encodeURIComponent(prompt);
  const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true`;
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60000,
  });
  
  const contentType = response.headers['content-type'] || '';
  if (!contentType.includes('image/')) {
    throw new Error(`Unexpected content-type from Pollinations: "${contentType}"`);
  }

  logger.debug(`imageGen: received ${response.data.byteLength} bytes from Pollinations`);
  return Buffer.from(response.data);
}

module.exports = { generateImage };
