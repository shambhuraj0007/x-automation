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
const { getBufferQueueInfo, getQueueCount, getChannels, getActiveChannelId, setActiveChannelId } = require('./buffer');
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

    const channelId = req.body.channelId || getActiveChannelId();
    if (!channelId) {
      return res.status(500).json({ error: 'No active Buffer channel configured' });
    }

    const dryRun = process.env.DRY_RUN === 'true';

    const mode = req.body.mode || 'append'; // 'append' by default so we never lose existing queue

    // 1. Apply blackout to all scheduled times
    const cleanedPosts = posts.map(p => ({
      text: p.text,
      scheduledAt: skipBlackout(new Date(p.scheduledAt)).toISOString(),
    }));

    // 2. Save / Append posts to local queue
    let addedItems = [];
    if (mode === 'replace') {
      postQueue.saveBatch(cleanedPosts, channelId);
      addedItems = postQueue.getAllPosts(channelId);
      logger.info(`API: replaced local queue with ${cleanedPosts.length} posts for channel ${channelId}`);
    } else {
      const appendResult = postQueue.appendBatch(cleanedPosts, channelId);
      addedItems = appendResult.newItems;
      logger.info(`API: appended ${cleanedPosts.length} posts to local queue (total: ${postQueue.getStats(channelId).total})`);
    }

    // 3. Check current Buffer queue to know how many slots are available
    let currentBufferCount = 0;
    let lastScheduledAt = null;
    try {
      const bufferInfo = await getBufferQueueInfo(channelId);
      currentBufferCount = bufferInfo.count;
      lastScheduledAt = bufferInfo.lastScheduledAt;
    } catch (err) {
      logger.warn(`API: could not check Buffer queue info — ${err.message}. Assuming 0.`);
    }

    const availableSlots = Math.max(0, postQueue.BUFFER_MAX_QUEUE - currentBufferCount);
    const toScheduleNow = addedItems.slice(0, availableSlots);
    const queuedForLater = addedItems.length - toScheduleNow.length;

    logger.info(
      `API: Buffer has ${currentBufferCount}/10 posts (last at ${lastScheduledAt || 'none'}). ` +
      `Scheduling ${toScheduleNow.length} now, ${queuedForLater} queued for auto-fill.`
    );

    // 4. Schedule the first batch to Buffer
    const results = [];

    for (let i = 0; i < toScheduleNow.length; i++) {
      const post = toScheduleNow[i];
      const postIndex = post.index; // continuous 1-based index

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
    for (let i = toScheduleNow.length; i < addedItems.length; i++) {
      results.push({
        index: addedItems[i].index,
        success: true,
        scheduledAt: addedItems[i].scheduledAt,
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

// ── GET /api/channels ────────────────────────────────────────────────────

router.get('/channels', async (req, res) => {
  try {
    const channels = await getChannels();
    const activeChannelId = getActiveChannelId();
    res.json({ activeChannelId, channels });
  } catch (err) {
    logger.error(`API: /channels error — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/channels/switch ────────────────────────────────────────────

router.post('/channels/switch', async (req, res) => {
  try {
    const { channelId } = req.body;
    if (!channelId) {
      return res.status(400).json({ error: 'channelId is required' });
    }

    const channels = await getChannels();
    const matched = channels.find(c => c.id === channelId);
    if (!matched) {
      return res.status(404).json({ error: `Channel with id ${channelId} not found` });
    }

    setActiveChannelId(channelId);
    logger.info(`API: switched active channel to "${matched.displayName || matched.name}" (${channelId})`);
    res.json({ success: true, activeChannelId: channelId, channel: matched });
  } catch (err) {
    logger.error(`API: /channels/switch error — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/queue ───────────────────────────────────────────────────────

router.get('/queue', async (req, res) => {
  try {
    const targetChannelId = req.query.channelId || getActiveChannelId();
    const info = await getBufferQueueInfo(targetChannelId);
    const stats = postQueue.getStats(targetChannelId);
    const localHighest = postQueue.getHighestScheduledTime(targetChannelId);
    const minSpacing = parseInt(process.env.MIN_SPACING_MINUTES || '60', 10);
    const maxSpacing = parseInt(process.env.MAX_SPACING_MINUTES || '90', 10);

    // Find the highest/latest scheduled time between Buffer and local queue
    let highestScheduledAt = null;
    const candidates = [info.lastScheduledAt, localHighest].filter(Boolean);
    for (const c of candidates) {
      const d = new Date(c);
      if (!isNaN(d.getTime())) {
        if (!highestScheduledAt || d > new Date(highestScheduledAt)) {
          highestScheduledAt = d.toISOString();
        }
      }
    }

    res.json({
      activeChannelId: targetChannelId,
      count: info.count,
      lastScheduledAt: info.lastScheduledAt, // furthest in Buffer
      highestScheduledAt,                   // furthest overall (Buffer or local queue)
      minSpacing,
      maxSpacing,
      localQueue: stats,
    });
  } catch (err) {
    logger.error(`API: /queue error — ${err.message}`);
    res.json({
      activeChannelId: getActiveChannelId(),
      count: null,
      lastScheduledAt: null,
      highestScheduledAt: null,
      minSpacing: 60,
      maxSpacing: 90,
      localQueue: postQueue.getStats(),
      error: err.message,
    });
  }
});

// ── GET /api/posts ───────────────────────────────────────────────────────

router.get('/posts', async (req, res) => {
  try {
    const targetChannelId = req.query.channelId || getActiveChannelId();

    // 1. Fetch live scheduled posts from Buffer
    let bufferPosts = [];
    let bufferCount = 0;
    try {
      if (targetChannelId) {
        const bufferInfo = await getBufferQueueInfo(targetChannelId);
        bufferPosts = bufferInfo.posts || [];
        bufferCount = bufferInfo.count || 0;
      }
    } catch (err) {
      logger.warn(`API: could not fetch Buffer posts for /api/posts — ${err.message}`);
    }

    // 2. Fetch local queue posts for this channel
    const localPosts = postQueue.getAllPosts(targetChannelId);
    const stats = postQueue.getStats(targetChannelId);

    // 3. Construct the combined post list
    let combinedPosts = [];
    const bufferPostMap = new Map();
    bufferPosts.forEach(bp => {
      bufferPostMap.set(bp.id, bp);
    });

    if (localPosts.length > 0) {
      localPosts.forEach(lp => {
        if (lp.status === 'scheduled') {
          const matchingBufferPost = lp.bufferPostId ? bufferPostMap.get(lp.bufferPostId) : null;
          combinedPosts.push({
            id: lp.bufferPostId || ('p_' + lp.index),
            index: lp.index,
            text: lp.text,
            status: 'scheduled',
            scheduledAt: matchingBufferPost?.dueAt || lp.scheduledAt,
            inBuffer: true,
          });
          if (matchingBufferPost) {
            bufferPostMap.delete(matchingBufferPost.id);
          }
        } else if (lp.status === 'pending') {
          // In local queue waiting for 4-hour auto-fill cron
          combinedPosts.push({
            id: 'p_' + lp.index,
            index: lp.index,
            text: lp.text,
            status: 'queued', // UI displays as "🕐 Queued (auto-fill)"
            scheduledAt: lp.scheduledAt,
            inBuffer: false,
          });
        } else if (lp.status === 'error') {
          combinedPosts.push({
            id: 'p_' + lp.index,
            index: lp.index,
            text: lp.text,
            status: 'error',
            error: lp.error,
            scheduledAt: lp.scheduledAt,
            inBuffer: false,
          });
        }
      });

      // Include any remaining Buffer posts not in local queue
      bufferPostMap.forEach(bp => {
        combinedPosts.push({
          id: bp.id,
          index: combinedPosts.length + 1,
          text: bp.text,
          status: 'scheduled',
          scheduledAt: bp.dueAt,
          inBuffer: true,
        });
      });
    } else {
      // Local queue is empty, load all scheduled posts directly from Buffer
      bufferPosts.forEach((bp, idx) => {
        combinedPosts.push({
          id: bp.id,
          index: idx + 1,
          text: bp.text,
          status: 'scheduled',
          scheduledAt: bp.dueAt,
          inBuffer: true,
        });
      });
    }

    // Sort by scheduled time ascending
    combinedPosts.sort((a, b) => {
      if (!a.scheduledAt) return 1;
      if (!b.scheduledAt) return -1;
      return new Date(a.scheduledAt) - new Date(b.scheduledAt);
    });

    // Re-index continuous 1..N
    combinedPosts.forEach((p, i) => { p.index = i + 1; });

    // Determine highest scheduled time
    let highestScheduledAt = null;
    for (const p of combinedPosts) {
      if (p.scheduledAt) {
        const d = new Date(p.scheduledAt);
        if (!isNaN(d.getTime())) {
          if (!highestScheduledAt || d > new Date(highestScheduledAt)) {
            highestScheduledAt = d.toISOString();
          }
        }
      }
    }

    res.json({
      activeChannelId: targetChannelId,
      posts: combinedPosts,
      stats: {
        total: combinedPosts.length,
        inBuffer: combinedPosts.filter(p => p.status === 'scheduled').length,
        queued: combinedPosts.filter(p => p.status === 'queued').length,
        pending: combinedPosts.filter(p => p.status === 'pending').length,
      },
      bufferCount,
      highestScheduledAt,
    });
  } catch (err) {
    logger.error(`API: /posts error — ${err.message}`, err);
    res.status(500).json({ error: err.message, posts: [] });
  }
});

// ── POST /api/clear ──────────────────────────────────────────────────────

router.post('/clear', (req, res) => {
  const channelId = req.body?.channelId || getActiveChannelId();
  const cleared = postQueue.clearQueue(channelId);
  res.json({ success: true, message: 'Local queue cleared', queue: cleared });
});

module.exports = router;
