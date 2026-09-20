/**
 * src/api.js
 * Express API routes for the Post Scheduler dashboard.
 *
 * Buffer has a 10-post queue limit. This API:
 *   1. Saves ALL posts to the local queue (data/post-queue.json)
 *   2. Immediately schedules up to 10 to Buffer
 *   3. The 4-hour cron in autoFill.js handles the rest
 *
 * Endpoints:
 *   POST /api/schedule   — Save posts and schedule first batch to Buffer
 *   GET  /api/queue      — Get Buffer queue count + local queue stats
 *   GET  /api/posts      — Get all local posts with their statuses
 */

'use strict';

const express = require('express');
const logger = require('./logger');
const { getQueueCount } = require('./buffer');
const postQueue = require('./postQueue');

const router = express.Router();

// ── GraphQL client ───────────────────────────────────────────────────────
const axios = require('axios');
const pRetry = require('p-retry').default;

const BUFFER_GRAPHQL_URL = 'https://api.buffer.com/graphql';

// ── Blackout: skip 2 AM – 6 AM ──────────────────────────────────────────

const BLACKOUT_START = 2;
const BLACKOUT_END = 6;

function skipBlackout(date) {
  const d = new Date(date.getTime());
  const hour = d.getHours();
  if (hour >= BLACKOUT_START && hour < BLACKOUT_END) {
    d.setHours(BLACKOUT_END, 0, 0, 0);
  }
  return d;
}

// ── Buffer GraphQL helper ────────────────────────────────────────────────

async function scheduleToBuffer(channelId, text, scheduledAt) {
  const token = process.env.BUFFER_ACCESS_TOKEN;

  const result = await pRetry(
    async () => {
      const res = await axios.post(
        BUFFER_GRAPHQL_URL,
        {
          query: `
            mutation {
              createPost(input: {
                channelId: "${channelId}"
                text: ${JSON.stringify(text)}
                schedulingType: automatic
                mode: customScheduled
                dueAt: "${scheduledAt}"
              }) {
                ... on PostActionSuccess {
                  post { id text status dueAt }
                }
                ... on MutationError {
                  message
                }
              }
            }
          `,
        },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      if (res.data.errors) {
        throw new Error(res.data.errors.map(e => e.message).join('; '));
      }

      const createResult = res.data.data.createPost;
      if (createResult.message) {
        throw new Error(`Buffer mutation error: ${createResult.message}`);
      }
      return createResult.post;
    },
    {
      retries: 2,
      minTimeout: 2000,
      factor: 2,
      onFailedAttempt: (err) => {
        logger.warn(`API: Buffer schedule attempt ${err.attemptNumber} failed: ${err.message}`);
      },
    }
  );

  return result;
}

// ── POST /api/schedule ───────────────────────────────────────────────────

/**
 * Save all posts to local queue + schedule first batch (up to 10) to Buffer.
 *
 * Request body:
 * {
 *   posts: [{ text: string, scheduledAt: string (ISO) }]
 * }
 *
 * Response:
 * {
 *   saved: number,
 *   scheduledNow: number,
 *   queuedForLater: number,
 *   results: [{ index, success, scheduledAt, error? }]
 * }
 */
router.post('/schedule', async (req, res) => {
  try {
    const { posts } = req.body;

    if (!posts || !Array.isArray(posts) || posts.length === 0) {
      return res.status(400).json({ error: 'posts array is required and must not be empty' });
    }

    const channelId = process.env.BUFFER_CHANNEL_ID;
    if (!channelId) {
      return res.status(500).json({ error: 'BUFFER_CHANNEL_ID is not set' });
    }

    const dryRun = process.env.DRY_RUN === 'true';

    // 1. Apply blackout to all scheduled times
    const cleanedPosts = posts.map(p => ({
      text: p.text,
      scheduledAt: skipBlackout(new Date(p.scheduledAt)).toISOString(),
    }));

    // 2. Save ALL posts to local queue
    postQueue.saveBatch(cleanedPosts);
    logger.info(`API: saved ${cleanedPosts.length} posts to local queue`);

    // 3. Check current Buffer queue to know how many slots are available
    let currentBufferCount = 0;
    try {
      currentBufferCount = await getQueueCount();
    } catch (err) {
      logger.warn(`API: could not check Buffer queue count — ${err.message}. Assuming 0.`);
    }

    const availableSlots = Math.max(0, postQueue.BUFFER_MAX_QUEUE - currentBufferCount);
    const toScheduleNow = cleanedPosts.slice(0, availableSlots);
    const queuedForLater = cleanedPosts.length - toScheduleNow.length;

    logger.info(
      `API: Buffer has ${currentBufferCount} posts. ` +
      `Scheduling ${toScheduleNow.length} now, ${queuedForLater} queued for auto-fill.`
    );

    // 4. Schedule the first batch to Buffer
    const results = [];

    for (let i = 0; i < toScheduleNow.length; i++) {
      const post = toScheduleNow[i];
      const postIndex = i + 1; // 1-based index in the queue

      if (dryRun) {
        logger.info(
          `[DRY RUN] Would schedule post #${postIndex} at ${post.scheduledAt}:\n` +
          `"${post.text.slice(0, 120)}${post.text.length > 120 ? '...' : ''}"`
        );
        postQueue.markScheduled([postIndex], [{ scheduledAt: post.scheduledAt }]);
        results.push({
          index: postIndex,
          success: true,
          scheduledAt: post.scheduledAt,
          status: 'scheduled',
        });
      } else {
        try {
          const bufferPost = await scheduleToBuffer(channelId, post.text, post.scheduledAt);
          logger.info(`API: ✅ scheduled post #${postIndex} (id: ${bufferPost.id}) at ${bufferPost.dueAt}`);

          postQueue.markScheduled([postIndex], [{
            bufferPostId: bufferPost.id,
            scheduledAt: bufferPost.dueAt,
          }]);

          results.push({
            index: postIndex,
            success: true,
            scheduledAt: bufferPost.dueAt,
            postId: bufferPost.id,
            status: 'scheduled',
          });
        } catch (err) {
          logger.error(`API: ❌ failed to schedule post #${postIndex} — ${err.message}`);
          postQueue.markError(postIndex, err.message);
          results.push({
            index: postIndex,
            success: false,
            error: err.message,
            scheduledAt: post.scheduledAt,
            status: 'error',
          });
        }
      }
    }

    // 5. Build response for remaining queued posts
    for (let i = toScheduleNow.length; i < cleanedPosts.length; i++) {
      results.push({
        index: i + 1,
        success: true,
        scheduledAt: cleanedPosts[i].scheduledAt,
        status: 'queued',  // waiting for auto-fill cron
      });
    }

    const scheduledCount = results.filter(r => r.status === 'scheduled').length;
    const queuedCount = results.filter(r => r.status === 'queued').length;
    const failedCount = results.filter(r => r.status === 'error').length;

    logger.info(
      `API: done — ${scheduledCount} sent to Buffer, ${queuedCount} queued for later, ${failedCount} failed`
    );

    res.json({
      results,
      total: cleanedPosts.length,
      scheduledNow: scheduledCount,
      queuedForLater: queuedCount,
      failed: failedCount,
      bufferLimit: postQueue.BUFFER_MAX_QUEUE,
    });

  } catch (err) {
    logger.error(`API: /schedule error — ${err.message}`, err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/queue ───────────────────────────────────────────────────────

router.get('/queue', async (req, res) => {
  try {
    const count = await getQueueCount();
    const stats = postQueue.getStats();
    res.json({ count, localQueue: stats });
  } catch (err) {
    logger.error(`API: /queue error — ${err.message}`);
    res.json({ count: null, localQueue: postQueue.getStats(), error: err.message });
  }
});

// ── GET /api/posts ───────────────────────────────────────────────────────

router.get('/posts', (req, res) => {
  const posts = postQueue.getAllPosts();
  const stats = postQueue.getStats();
  res.json({ posts, stats });
});

module.exports = router;
