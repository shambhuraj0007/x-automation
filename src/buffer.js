/**
 * src/buffer.js
 * Buffer GraphQL API integration — queue management and post scheduling.
 *
 * Buffer deprecated their legacy REST API. This module uses the new GraphQL API.
 * Docs: https://developers.buffer.com
 * API Explorer: https://developers.buffer.com/explorer.html
 *
 * Auth: API key from https://publish.buffer.com/settings/api
 *       (NOT the old OAuth token — get a fresh key from Buffer settings)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const pRetry = require('p-retry').default;
const logger = require('./logger');
const { generateImage } = require('./imageGen');

const BUFFER_GRAPHQL_URL = 'https://api.buffer.com/graphql';
const CONFIG_FILE = path.join(process.cwd(), 'data', 'config.json');

// ── Active Channel Management ──────────────────────────────────────────────

function getActiveChannelId() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (cfg && cfg.activeChannelId) {
        return cfg.activeChannelId;
      }
    }
  } catch (err) {
    logger.debug(`Buffer: could not read config.json — ${err.message}`);
  }
  return process.env.BUFFER_CHANNEL_ID;
}

function setActiveChannelId(channelId) {
  try {
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let cfg = {};
    if (fs.existsSync(CONFIG_FILE)) {
      try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch {}
    }
    cfg.activeChannelId = channelId;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (err) {
    logger.warn(`Buffer: could not write config.json — ${err.message}`);
  }
  process.env.BUFFER_CHANNEL_ID = channelId;
  logger.info(`Buffer: active channel switched to ${channelId}`);
}

// ── GraphQL client ──────────────────────────────────────────────────────────

async function gql(query, variables = {}) {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  if (!token) throw new Error('BUFFER_ACCESS_TOKEN is not set in .env');

  const res = await axios.post(
    BUFFER_GRAPHQL_URL,
    { query, variables },
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );

  if (res.data.errors) {
    const msg = res.data.errors.map(e => e.message).join('; ');
    throw new Error(`Buffer GraphQL error: ${msg}`);
  }

  return res.data.data;
}

// ── One-time setup helpers ──────────────────────────────────────────────────

/**
 * Fetch the organizationId and channelId for your Twitter/X account.
 * Run this once to populate BUFFER_ORG_ID and BUFFER_CHANNEL_ID in .env.
 * @returns {Promise<void>}
 */
async function discoverIds() {
  logger.info('Buffer: discovering organization and channel IDs...');

  // 1. Get organization ID
  const accountData = await gql(`
    query {
      account {
        id
        email
        organizations {
          id
          name
        }
      }
    }
  `);

  const orgs = accountData.account.organizations;
  logger.info(`Buffer: found ${orgs.length} organization(s):`);
  for (const org of orgs) {
    logger.info(`  Org: "${org.name}" → id: ${org.id}`);
  }

  if (orgs.length === 0) {
    logger.error('No organizations found. Make sure your API key has the right permissions.');
    return;
  }

  // Use the first org (or the one in env)
  const orgId = process.env.BUFFER_ORG_ID || orgs[0].id;

  // 2. Get channels (profiles) for the org
  const channelsData = await gql(`
    query {
      channels(input: { organizationId: "${orgId}" }) {
        id
        name
        service
        displayName
        avatar
        isQueuePaused
      }
    }
  `);

  const channels = channelsData.channels;
  logger.info(`Buffer: found ${channels.length} channel(s):`);
  for (const ch of channels) {
    logger.info(`  [${ch.service}] "${ch.displayName || ch.name}" → id: ${ch.id}`);
  }

  // Find Twitter/X channel
  const twitter = channels.find(c =>
    c.service === 'twitter' || c.service === 'x' ||
    (c.name || '').toLowerCase().includes('twitter') ||
    (c.name || '').toLowerCase().includes('x')
  );

  if (twitter) {
    logger.info(`\n✅ Found your X/Twitter channel:`);
    logger.info(`   Add to .env: BUFFER_ORG_ID=${orgId}`);
    logger.info(`   Add to .env: BUFFER_CHANNEL_ID=${twitter.id}`);
  } else {
    logger.warn('Could not auto-detect Twitter/X channel. Pick the correct id above and add it to .env as BUFFER_CHANNEL_ID.');
  }
}

// ── Spacing helper ──────────────────────────────────────────────────────────

function randomMinutes(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Given a base Date, add a random 45–120 minute offset.
 */
function nextScheduledTime(base) {
  const minMins = parseInt(process.env.MIN_SPACING_MINUTES || '60', 10);
  const maxMins = parseInt(process.env.MAX_SPACING_MINUTES || '90', 10);
  const offset = randomMinutes(minMins, maxMins) * 60 * 1000;
  return new Date(base.getTime() + offset);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch all available channels for the configured organization.
 * @returns {Promise<Array<{id: string, name: string, displayName: string, service: string, avatar: string}>>}
 */
async function getChannels() {
  const orgId = process.env.BUFFER_ORG_ID;
  if (!orgId) throw new Error('BUFFER_ORG_ID is not set in .env');

  return pRetry(
    async () => {
      const data = await gql(`
        query {
          channels(input: { organizationId: "${orgId}" }) {
            id
            name
            service
            displayName
            avatar
            isQueuePaused
          }
        }
      `);
      return data.channels || [];
    },
    { retries: 2, minTimeout: 1500 }
  );
}

/**
 * Fetch scheduled posts info from Buffer:
 * - count: total number of scheduled posts
 * - lastScheduledAt: ISO string of the post scheduled furthest out in time (or null)
 * - posts: array of { id, dueAt, text, status }
 *
 * @param {string} [targetChannelId] - Optional specific channel ID to query
 * @returns {Promise<{count: number, lastScheduledAt: string|null, posts: Array}>}
 */
async function getBufferQueueInfo(targetChannelId) {
  const orgId = process.env.BUFFER_ORG_ID;
  const channelId = targetChannelId || getActiveChannelId();

  if (!orgId || !channelId) {
    throw new Error(
      'BUFFER_ORG_ID and BUFFER_CHANNEL_ID must be set in .env. ' +
      'Run: node src/setup.js to discover them automatically.'
    );
  }

  return pRetry(
    async () => {
      const data = await gql(`
        query {
          posts(
            first: 100
            input: {
              organizationId: "${orgId}"
              filter: {
                status: [scheduled]
                channelIds: ["${channelId}"]
              }
            }
          ) {
            edges {
              node {
                id
                dueAt
                status
                text
              }
            }
          }
        }
      `);

      const edges = data.posts?.edges ?? [];
      const scheduledPosts = edges.map(e => e.node).filter(n => n.dueAt);

      // Sort by dueAt ascending (furthest in future is last)
      scheduledPosts.sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));

      const count = scheduledPosts.length;
      const lastPost = count > 0 ? scheduledPosts[count - 1] : null;

      logger.debug(`Buffer: ${count} scheduled post(s). Last scheduled at: ${lastPost?.dueAt || 'none'}`);

      return {
        count,
        lastScheduledAt: lastPost ? lastPost.dueAt : null,
        posts: scheduledPosts,
      };
    },
    {
      retries: 3,
      minTimeout: 2000,
      factor: 2,
      onFailedAttempt: (err) => {
        logger.warn(`Buffer getBufferQueueInfo attempt ${err.attemptNumber} failed: ${err.message}`);
      },
    }
  );
}

/**
 * Fetch the number of scheduled (pending) posts in the Buffer queue
 * for the configured channel.
 *
 * @returns {Promise<number>}
 */
async function getQueueCount(targetChannelId) {
  const info = await getBufferQueueInfo(targetChannelId);
  return info.count;
}

/**
 * Schedule an array of posts into Buffer, spaced randomly 45–120 min apart.
 * The first post is scheduled MIN_SPACING minutes from now.
 *
 * @param {string[]} posts  - Array of tweet text strings
 * @returns {Promise<void>}
 */
async function schedulePosts(posts) {
  const channelId = process.env.BUFFER_CHANNEL_ID;
  if (!channelId) throw new Error('BUFFER_CHANNEL_ID is not set in .env');

  const dryRun = process.env.DRY_RUN === 'true';
  let baseTime = new Date(); // Start scheduling from now

  for (let i = 0; i < posts.length; i++) {
    const scheduledAt = nextScheduledTime(baseTime);

    const postObj = typeof posts[i] === 'string' ? { text: posts[i] } : posts[i];

    if (dryRun) {
      logger.info(
        `[DRY RUN] Would schedule post ${i + 1}/${posts.length} at ${scheduledAt.toISOString()}:\n` +
        `"${postObj.text.slice(0, 120)}${postObj.text.length > 120 ? '...' : ''}"` +
        (postObj.imagePrompt ? `\n[IMAGE PROMPT: ${postObj.imagePrompt}]` : '')
      );
    } else {
      try {
        await _scheduleOne(channelId, postObj, scheduledAt, i + 1, posts.length);
      } catch (err) {
        logger.error(`Buffer: failed to schedule post ${i + 1}/${posts.length} — ${err.message}`);
      }
    }

    baseTime = scheduledAt;
  }
}

/**
 * Internal: schedule a single post via Buffer GraphQL API with retry.
 * @private
 */
async function _scheduleOne(channelId, postObj, scheduledAt, index, total) {
  let assetsField = '';

  // Use a pre-resolved URL if available, otherwise generate now
  let imageUrl = postObj.imageUrl;
  if (imageUrl === undefined && postObj.imagePrompt) {
    imageUrl = await generateImage(postObj.imagePrompt);
  }

  if (imageUrl) {
    assetsField = `
            assets: [
              {
                image: {
                  url: "${imageUrl}"
                }
              }
            ]
    `;
  } else if (postObj.imagePrompt) {
    logger.warn(`Buffer: image generation failed for post ${index} — posting text only`);
  }

  await pRetry(
    async () => {
      const data = await gql(`
        mutation {
          createPost(input: {
            channelId: "${channelId}"
            text: ${JSON.stringify(postObj.text)}
            schedulingType: automatic
            mode: customScheduled
            dueAt: "${scheduledAt.toISOString()}"
            ${assetsField}
          }) {
            ... on PostActionSuccess {
              post {
                id
                text
                status
                dueAt
              }
            }
            ... on MutationError {
              message
            }
          }
        }
      `);

      const result = data.createPost;

      // Check for GraphQL-level mutation errors
      if (result.message) {
        throw new Error(`Buffer mutation error: ${result.message}`);
      }

      const post = result.post;
      logger.info(
        `Buffer: scheduled post ${index}/${total} (id: ${post.id}) ` +
        `at ${post.dueAt} — ` +
        `"${postObj.text.slice(0, 60)}${postObj.text.length > 60 ? '...' : ''}"` +
        (postObj.imagePrompt ? ' [🖼️ AI Image included]' : '')
      );
    },
    {
      retries: 3,
      minTimeout: 3000,
      factor: 2,
      onFailedAttempt: (err) => {
        logger.warn(`Buffer schedulePost attempt ${err.attemptNumber} failed: ${err.message}`);
      },
    }
  );
}

module.exports = {
  getBufferQueueInfo,
  getQueueCount,
  schedulePosts,
  nextScheduledTime,
  discoverIds,
  getChannels,
  getActiveChannelId,
  setActiveChannelId,
};
