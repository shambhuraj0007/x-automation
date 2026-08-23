/**
 * src/gemini.js
 * Gemini API integration — generates viral tweets with duplicate detection.
 */

'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const pRetry = require('p-retry').default;
const logger = require('./logger');
const topicRegistry = require('./topicRegistry');
const { buildPrompt, parseResponse } = require('./prompt');

// Initialise Gemini client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Generate a batch of viral tweets using the Gemini API.
 *
 * @param {Object} opts
 * @param {number} [opts.count=3]  - How many posts to generate
 * @returns {Promise<string[]>}    - Array of tweet strings
 */
async function generatePosts({ count = 3 } = {}) {
  const niche = process.env.TWEET_NICHE || 'AI and technology';
  const subtopics = (process.env.TWEET_SUBTOPICS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const recentTopics = topicRegistry.getRecent();

  logger.info(`Gemini: generating ${count} posts for niche "${niche}"...`);
  if (recentTopics.length > 0) {
    logger.debug(`Gemini: avoiding ${recentTopics.length} recent topics`);
  }

  const prompt = buildPrompt({ niche, subtopics, recentTopics, count });

  // Call Gemini with automatic retry on transient failures
  const { tweets, topics } = await pRetry(
    () => _callGemini(prompt, count),
    {
      retries: 3,
      minTimeout: 2000,
      maxTimeout: 10000,
      factor: 2,
      onFailedAttempt: (error) => {
        logger.warn(
          `Gemini: attempt ${error.attemptNumber} failed. ` +
          `${error.retriesLeft} retries left. Error: ${error.message}`
        );
      },
    }
  );

  // Filter out any duplicates based on the first 50 characters
  const fresh = tweets.filter(tweet => {
    const first50 = tweet.text.slice(0, 50);
    if (topicRegistry.isDuplicate(first50)) {
      logger.debug(`Gemini: filtered duplicate tweet starting with: "${first50}..."`);
      return false;
    }
    return true;
  });

  if (fresh.length === 0) {
    throw new Error('Gemini: all generated posts were duplicates — retrying on next cycle');
  }

  if (fresh.length < count) {
    logger.warn(`Gemini: ${count - fresh.length} post(s) less than requested were generated (filtered as duplicates). Proceeding with ${fresh.length}.`);
  }

  // Register the first 50 characters so future runs avoid starting tweets the same way
  const recentLines = fresh.map(tweet => tweet.text.slice(0, 50));
  topicRegistry.register(recentLines);

  logger.info(`Gemini: successfully generated ${fresh.length} post(s)`);
  return fresh;
}

/**
 * Internal: single Gemini API call.
 * @private
 */
async function _callGemini(prompt, count) {
  const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const model = genAI.getGenerativeModel(
    {
      model: modelName,
      generationConfig: {
        temperature: 0.92,        // High creativity
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 2048,
      },
    },
    { apiVersion: 'v1' }   // This key is on v1 (stable), not v1beta
  );

  const result = await model.generateContent(prompt);
  const rawText = result.response.text();

  if (!rawText || rawText.trim().length < 20) {
    throw new Error('Gemini returned empty or too-short response');
  }

  logger.debug(`Gemini: raw response length ${rawText.length} chars`);

  const { tweets, topics } = parseResponse(rawText);

  if (tweets.length === 0) {
    throw new Error('Gemini: could not parse any tweets from response');
  }

  logger.debug(`Gemini: parsed ${tweets.length} tweets, ${topics.length} topics`);
  return { tweets, topics };
}

module.exports = { generatePosts };
