/**
 * src/api.js
 * Express API routes for the Post Scheduler dashboard.
 *
 * Buffer has a 10-post queue limit. This API:
 *   1. Saves ALL posts to MongoDB (each post = own document)
 *   2. Checks Buffer for empty slots + gets latest scheduled time
 *   3. Schedules posts to Buffer starting after the latest post
 *   4. The 3-hour cron in autoFill.js handles remaining pending posts
 *
 * Endpoints:
 *   POST /api/schedule   — Save posts to MongoDB and schedule first batch to Buffer
 *   GET  /api/queue      — Get Buffer queue count + local queue stats
 *   GET  /api/posts      — Get all posts with their statuses
 */

'use strict';

const express = require('express');
const logger = require('./logger');
const { getBufferQueueInfo, getQueueCount, getChannels, getActiveChannelId, setActiveChannelId, clearBufferCache } = require('./buffer');
const postQueue = require('./postQueue');

const router = express.Router();

// ── GraphQL client ───────────────────────────────────────────────────────
const axios = require('axios');
const pRetry = require('p-retry').default;

const BUFFER_GRAPHQL_URL = 'https://api.buffer.com/graphql';

// ── Blackout: skip 2 AM – 6 AM ──────────────────────────────────────────

const BLACKOUT_START = 2;
const BLACKOUT_END = 6;
const TIMEZONE = process.env.TIMEZONE || 'Asia/Kolkata';

function getHourInTimezone(date, tz = TIMEZONE) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false,
    }).formatToParts(date);
    const hourPart = parts.find(p => p.type === 'hour');
    return hourPart ? parseInt(hourPart.value, 10) : date.getHours();
  } catch {
    return date.getHours();
  }
}

function skipBlackout(date, tz = TIMEZONE) {
  let d = new Date(date.getTime());
  let hour = getHourInTimezone(d, tz);
  if (hour >= BLACKOUT_START && hour < BLACKOUT_END) {
    while (hour >= BLACKOUT_START && hour < BLACKOUT_END) {
      d = new Date(d.getTime() + 30 * 60 * 1000);
      hour = getHourInTimezone(d, tz);
    }
    d.setMinutes(0, 0, 0);
  }
  return d;
}

// ── Buffer GraphQL helper ────────────────────────────────────────────────

async function scheduleToBuffer(channelId, text, scheduledAt) {
  const token = process.env.BUFFER_ACCESS_TOKEN;

  const result = await pRetry(
    async () => {
      try {
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
      } catch (err) {
        if (err.response && err.response.status === 429) {
          const retryHeader = err.response.headers['retry-after'];
          const waitSec = retryHeader ? Math.max(parseInt(retryHeader, 10), 6) : 6;
          logger.warn(`API: Buffer 429 Rate Limit hit — waiting ${waitSec}s before retrying...`);
          await new Promise(r => setTimeout(r, waitSec * 1000));
        }
        throw err;
      }
    },
    {
      retries: 1,
      minTimeout: 1000,
      factor: 1.5,
      onFailedAttempt: (err) => {
        logger.warn(`API: Buffer schedule attempt ${err.attemptNumber} failed: ${err.message}`);
      },
    }
  );

  return result;
}

// ── POST /api/schedule ───────────────────────────────────────────────────

/**
 * Flow:
 *   1. Check Buffer queue → get empty slots + latest scheduled post time
 *   2. Calculate posting times starting AFTER Buffer's latest post
 *   3. Save ALL posts to MongoDB (each post = own document)
 *   4. Push posts to Buffer (up to available slots)
 *   5. Remaining posts stay as 'pending' in MongoDB for 3h auto-fill cron
 *
 * Request body:
 * {
 *   posts: [{ text: string, scheduledAt: string (ISO) }],
 *   channelId?: string,
 *   mode?: 'append' | 'replace'
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
    const mode = req.body.mode || 'append';

    // ── STEP 1: Check Buffer queue for empty slots + latest scheduled time ──
    let currentBufferCount = 0;
    let lastScheduledAt = null;
    try {
      const bufferInfo = await getBufferQueueInfo(channelId);
      currentBufferCount = bufferInfo.count;
      lastScheduledAt = bufferInfo.lastScheduledAt;
      logger.info(`API: 📊 Buffer queue: ${currentBufferCount}/10 posts. Latest scheduled: ${lastScheduledAt || 'none'}`);
    } catch (err) {
      logger.warn(`API: could not check Buffer queue info — ${err.message}. Assuming 0.`);
    }

    const minSpacing = parseInt(process.env.MIN_SPACING_MINUTES || '60', 10);
    const maxSpacing = parseInt(process.env.MAX_SPACING_MINUTES || '90', 10);

    // ── STEP 2: Calculate posting times starting AFTER Buffer's latest post ──
    // If Buffer has existing posts, ALL new posts schedule AFTER the last one
    const bufferLatestDate = (lastScheduledAt && new Date(lastScheduledAt) > new Date())
      ? new Date(lastScheduledAt)
      : null;

    if (bufferLatestDate) {
      logger.info(`API: 📅 Buffer's latest post is at ${bufferLatestDate.toISOString()} — new posts will schedule after this`);
    }

    // Also check local queue for any pending posts with future scheduled times
    const localHighest = postQueue.getHighestScheduledTime(channelId);
    let prevTime = bufferLatestDate;

    // Use whichever is later: Buffer's latest OR local queue's latest
    if (localHighest) {
      const localDate = new Date(localHighest);
      if (!prevTime || localDate > prevTime) {
        prevTime = localDate;
        logger.info(`API: 📅 Local queue has posts scheduled up to ${localDate.toISOString()} — starting after this`);
      }
    }

    const cleanedPosts = [];

    for (let i = 0; i < posts.length; i++) {
      let candidateTime = new Date(posts[i].scheduledAt);
      if (isNaN(candidateTime.getTime())) {
        candidateTime = prevTime
          ? new Date(prevTime.getTime() + minSpacing * 60 * 1000)
          : new Date(Date.now() + minSpacing * 60 * 1000);
      }

      // Enforce minimum spacing after previous post (or Buffer's latest)
      if (prevTime) {
        const minAllowedTime = new Date(prevTime.getTime() + minSpacing * 60 * 1000);
        if (candidateTime < minAllowedTime) {
          candidateTime = minAllowedTime;
        }
      }

      // Apply timezone-aware blackout (skip 2-6 AM)
      candidateTime = skipBlackout(candidateTime);

      // If skipBlackout moved it to a time that collides with prevTime, advance it
      if (prevTime && candidateTime.getTime() <= prevTime.getTime()) {
        const offsetMs = (Math.floor(Math.random() * (maxSpacing - minSpacing + 1)) + minSpacing) * 60 * 1000;
        candidateTime = skipBlackout(new Date(prevTime.getTime() + offsetMs));
      }

      prevTime = candidateTime;
      cleanedPosts.push({
        text: posts[i].text,
        scheduledAt: candidateTime.toISOString(),
      });
    }

    // ── STEP 3: Save ALL posts to MongoDB (each post = own document) ──
    let addedItems = [];
    if (mode === 'replace') {
      postQueue.saveBatch(cleanedPosts, channelId);
      addedItems = postQueue.getAllPosts(channelId);
      logger.info(`API: 💾 Saved ${cleanedPosts.length} posts to MongoDB (replaced queue) for channel ${channelId}`);
    } else {
      const appendResult = postQueue.appendBatch(cleanedPosts, channelId);
      addedItems = appendResult.newItems;
      logger.info(`API: 💾 Saved ${cleanedPosts.length} posts to MongoDB (appended). Total in queue: ${postQueue.getStats(channelId).total}`);
    }

    // ── STEP 4: Push posts to Buffer (up to available slots) ──
    const availableSlots = Math.max(0, postQueue.BUFFER_MAX_QUEUE - currentBufferCount);
    const toScheduleNow = addedItems.slice(0, availableSlots);
    const queuedForLater = addedItems.length - toScheduleNow.length;

    logger.info(
      `API: 🚀 ${availableSlots} Buffer slots free. Scheduling ${toScheduleNow.length} now, ${queuedForLater} saved in MongoDB for auto-fill.`
    );

    const results = [];
    let rateLimitHit = false;

    for (let i = 0; i < toScheduleNow.length; i++) {
      const post = toScheduleNow[i];
      const postIndex = post.index;

      if (rateLimitHit) {
        results.push({
          index: postIndex,
          success: true,
          scheduledAt: post.scheduledAt,
          status: 'queued',
        });
        continue;
      }

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
        // 250ms spacing between Buffer API calls
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 250));
        }

        try {
          const bufferPost = await scheduleToBuffer(channelId, post.text, post.scheduledAt);
          logger.info(`API: ✅ Post #${postIndex} → Buffer (id: ${bufferPost.id}) at ${bufferPost.dueAt}`);

          // Update post in MongoDB with Buffer post ID
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
          const is429 = err.response?.status === 429 || (err.message && err.message.includes('429'));
          if (is429) {
            rateLimitHit = true;
            logger.warn(`API: ⚠️ Buffer 429 rate limit at post #${postIndex}. Post stays safe in MongoDB.`);
            results.push({
              index: postIndex,
              success: true,
              scheduledAt: post.scheduledAt,
              status: 'queued',
            });
          } else {
            logger.error(`API: ❌ Failed to schedule post #${postIndex} — ${err.message}`);
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
    }

    // ── STEP 5: Report remaining posts (safely in MongoDB for auto-fill) ──
    for (let i = toScheduleNow.length; i < addedItems.length; i++) {
      results.push({
        index: addedItems[i].index,
        success: true,
        scheduledAt: addedItems[i].scheduledAt,
        status: 'queued',  // safe in MongoDB, auto-fill cron will schedule later
      });
    }

    const scheduledCount = results.filter(r => r.status === 'scheduled').length;
    const queuedCount = results.filter(r => r.status === 'queued').length;
    const failedCount = results.filter(r => r.status === 'error').length;

    clearBufferCache();
    logger.info(
      `API: ✅ Done — ${scheduledCount} → Buffer, ${queuedCount} → MongoDB (pending), ${failedCount} failed` +
      (rateLimitHit ? ' [rate-limited]' : '')
    );

    res.json({
      results,
      total: cleanedPosts.length,
      scheduledNow: scheduledCount,
      queuedForLater: queuedCount,
      failed: failedCount,
      rateLimited: rateLimitHit,
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

// ── GET /api/history ────────────────────────────────────────────────────

router.get('/history', (req, res) => {
  const channelId = req.query.channelId || getActiveChannelId();
  const history = postQueue.getHistory(channelId);
  res.json({ success: true, history });
});

// ── POST /api/clear ──────────────────────────────────────────────────────

router.post('/clear', (req, res) => {
  const channelId = req.body?.channelId || getActiveChannelId();
  const cleared = postQueue.clearQueue(channelId);
  res.json({ success: true, message: 'Local queue cleared', queue: cleared });
});

module.exports = router;
