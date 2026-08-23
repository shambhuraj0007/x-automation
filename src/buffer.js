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

const axios = require('axios');
const pRetry = require('p-retry').default;
const logger = require('./logger');

const BUFFER_GRAPHQL_URL = 'https://api.buffer.com/graphql';

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
  const minMins = parseInt(process.env.MIN_SPACING_MINUTES || '45', 10);
  const maxMins = parseInt(process.env.MAX_SPACING_MINUTES || '120', 10);
  const offset = randomMinutes(minMins, maxMins) * 60 * 1000;
  return new Date(base.getTime() + offset);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch the number of scheduled (pending) posts in the Buffer queue
 * for the configured channel.
 *
 * @returns {Promise<number>}
 */
async function getQueueCount() {
  const orgId = process.env.BUFFER_ORG_ID;
  const channelId = process.env.BUFFER_CHANNEL_ID;

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
              node { id }
            }
            pageInfo {
              hasNextPage
            }
          }
        }
      `);

      const edges = data.posts?.edges ?? [];
      const count = edges.length;
      const hasMore = data.posts?.pageInfo?.hasNextPage;

      // If there are more than 100 posts queued, that's definitely enough
      const effective = hasMore ? count + 1 : count;
      logger.debug(`Buffer: scheduled queue count = ${effective}${hasMore ? '+' : ''}`);
      return effective;
    },
    {
      retries: 3,
      minTimeout: 2000,
      factor: 2,
      onFailedAttempt: (err) => {
        logger.warn(`Buffer getQueueCount attempt ${err.attemptNumber} failed: ${err.message}`);
      },
    }
  );
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
      await _scheduleOne(channelId, postObj, scheduledAt, i + 1, posts.length);
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
  if (postObj.imagePrompt) {
    // Generate an AI image URL via Pollinations AI (free, no-auth, dynamic generation)
    const encodedPrompt = encodeURIComponent(postObj.imagePrompt);
    const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true`;
    assetsField = `
            assets: [
              {
                image: {
                  url: "${imageUrl}"
                }
              }
            ]
    `;
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

module.exports = { getQueueCount, schedulePosts, nextScheduledTime, discoverIds };
