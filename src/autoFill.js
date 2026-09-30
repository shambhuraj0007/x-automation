/**
 * src/autoFill.js
 * 3-hour cron that keeps Buffer queue at 10 posts by pulling from the local queue.
 *
 * Every 3 hours:
 *   1. Clean up published posts from local queue (time-based + API-based)
 *   2. Check how many posts are currently in Buffer queue
 *   3. If < 10, pull enough pending posts from local queue to fill it
 *   4. Schedule those posts to Buffer with proper time spacing
 *   5. Skip 2 AM – 6 AM posting window
 */

'use strict';

const cron = require('node-cron');
const logger = require('./logger');
const { getBufferQueueInfo, getQueueCount, getActiveChannelId, getSentPosts, getFailedPosts, clearBufferCache } = require('./buffer');
const postQueue = require('./postQueue');
const { schedulePostToBuffer } = require('./api');

let isRefilling = false;

// ── Blackout window ─────────────────────────────────────────────────────

const BLACKOUT_START_HOUR = 2;  // 2:00 AM
const BLACKOUT_END_HOUR = 6;   // 6:00 AM
const TIMEZONE = process.env.TIMEZONE || 'Asia/Kolkata';

/**
 * Get hour of a date in the target timezone.
 */
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

/**
 * If a date falls within the 2 AM – 6 AM blackout window in TIMEZONE,
 * push it forward to 6 AM same day.
 */
function skipBlackout(date, tz = TIMEZONE) {
  let d = new Date(date.getTime());
  let hour = getHourInTimezone(d, tz);
  if (hour >= BLACKOUT_START_HOUR && hour < BLACKOUT_END_HOUR) {
    while (hour >= BLACKOUT_START_HOUR && hour < BLACKOUT_END_HOUR) {
      d = new Date(d.getTime() + 30 * 60 * 1000);
      hour = getHourInTimezone(d, tz);
    }
    d.setMinutes(0, 0, 0);
  }
  return d;
}

/**
 * Calculate the next posting time with random spacing, skipping 2–6 AM.
 */
function nextPostTime(baseTime, minSpacingMin, maxSpacingMin) {
  const minMs = (minSpacingMin || 60) * 60 * 1000;
  const maxMs = (maxSpacingMin || 90) * 60 * 1000;
  const offset = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;

  let next = new Date(baseTime.getTime() + offset);
  next = skipBlackout(next);
  return next;
}

// ── Cleanup logic ───────────────────────────────────────────────────────

/**
 * Clean up posts that have been published to Twitter by Buffer.
 * Buffer API is the source of truth:
 *   1. Check Buffer sent posts (status: sent) -> mark published & archive
 *   2. Check Buffer failed posts (status: error) -> mark error, retain in queue
 *   3. Only fall back to time-based cleanup if post is >6 hours overdue AND API confirmed
 */
async function cleanupPublishedPosts() {
  const channelId = getActiveChannelId();
  const scheduled = postQueue.getScheduledPosts(channelId);

  if (scheduled.length === 0) {
    logger.debug('Cleanup: no scheduled posts in local queue — nothing to clean');
    return;
  }

  // Optimize API calls: Only query Buffer if at least one post has reached or passed its scheduled time
  const now = Date.now();
  const hasPastDuePosts = scheduled.some(p => p.scheduledAt && new Date(p.scheduledAt).getTime() <= now);
  if (!hasPastDuePosts) {
    logger.debug('Cleanup: no scheduled posts have reached their due time yet — skipping Buffer sent/failed checks');
    return;
  }

  logger.info(`Cleanup: verifying ${scheduled.length} scheduled post(s) against Buffer API...`);

  const indicesToMarkPublished = [];
  let bufferApiSuccess = false;

  try {
    const [sentPosts, failedPosts] = await Promise.all([
      getSentPosts(channelId).catch(err => {
        logger.warn(`Cleanup: could not fetch sent posts — ${err.message}`);
        return null;
      }),
      getFailedPosts(channelId).catch(err => {
        logger.warn(`Cleanup: could not fetch failed posts — ${err.message}`);
        return null;
      }),
    ]);

    const sentIds = sentPosts ? new Set(sentPosts.map(p => p.id)) : null;
    const failedIds = failedPosts ? new Set(failedPosts.map(p => p.id)) : null;

    if (sentIds !== null) {
      bufferApiSuccess = true;
    }

    for (const post of scheduled) {
      // 1. Check if explicitly marked as failed on Buffer
      if (failedIds && post.bufferPostId && failedIds.has(post.bufferPostId)) {
        logger.error(`Cleanup: post #${post.index} (id: ${post.bufferPostId}) failed to publish on Twitter/Buffer`);
        postQueue.markError(post.index, 'Buffer reported: publication failed on Twitter');
        continue;
      }

      // 2. Check if explicitly verified in Buffer's sent posts
      if (sentIds && post.bufferPostId && sentIds.has(post.bufferPostId)) {
        indicesToMarkPublished.push(post.index);
        logger.info(`Cleanup: post #${post.index} (id: ${post.bufferPostId}) verified sent on Twitter`);
        continue;
      }

      // 3. Fallback: only if post is past scheduledAt by more than 6 hours AND API check ran
      if (post.scheduledAt) {
        const dueAt = new Date(post.scheduledAt);
        const hoursOverdue = (Date.now() - dueAt.getTime()) / (1000 * 60 * 60);

        if (bufferApiSuccess && hoursOverdue > 6) {
          logger.info(`Cleanup: post #${post.index} was due ${Math.round(hoursOverdue)}h ago (${post.scheduledAt}) — marking published (overdue fallback)`);
          indicesToMarkPublished.push(post.index);
        }
      }
    }
  } catch (err) {
    logger.warn(`Cleanup: Buffer API check encountered an error — ${err.message}. Retaining queue for safety.`);
  }

  // Mark verified published posts and archive to history.json
  if (indicesToMarkPublished.length > 0) {
    postQueue.markPublished(indicesToMarkPublished);
    const removed = postQueue.removePublishedPosts(channelId);
    logger.info(`Cleanup: ✅ archived and cleaned up ${removed} verified post(s) from active queue`);
  } else {
    logger.info('Cleanup: no new published posts to clean up');
  }
}

/**
 * If the server was down/offline, pending posts might have scheduledAt timestamps
 * that are now in the past. DO NOT delete them! Reschedule them forward!
 */
function rescheduleExpiredPendingPosts(channelId) {
  const queue = postQueue.readQueue();
  const posts = queue.posts || [];
  const now = new Date();
  let updatedCount = 0;
  const minSpacing = parseInt(process.env.MIN_SPACING_MINUTES || '60', 10);
  const maxSpacing = parseInt(process.env.MAX_SPACING_MINUTES || '90', 10);

  let baseTime = new Date(now.getTime() + minSpacing * 60 * 1000);
  baseTime = skipBlackout(baseTime);

  for (const post of posts) {
    if (channelId && post.channelId && post.channelId !== channelId) continue;
    if (post.status === 'pending' && post.scheduledAt) {
      const due = new Date(post.scheduledAt);
      if (!isNaN(due.getTime()) && due < now) {
        post.scheduledAt = baseTime.toISOString();
        updatedCount++;
        const offset = (Math.floor(Math.random() * (maxSpacing - minSpacing + 1)) + minSpacing) * 60 * 1000;
        baseTime = skipBlackout(new Date(baseTime.getTime() + offset));
      }
    }
  }

  if (updatedCount > 0) {
    postQueue.writeQueue(queue);
    logger.info(`AutoFill: 🔄 Rescheduled ${updatedCount} expired pending post(s) forward so they are not lost!`);
  }
}

// ── Auto-fill logic ─────────────────────────────────────────────────────

/**
 * Clean up published posts, then check Buffer queue and fill it up to 10 from the local queue.
 */
async function autoFillQueue() {
  if (isRefilling) {
    logger.debug('AutoFill: refill already in progress — skipping');
    return;
  }

  isRefilling = true;

  try {
    const channelId = getActiveChannelId();

    // 0. Reschedule any pending posts that expired while server was offline!
    rescheduleExpiredPendingPosts(channelId);

    // 1. Clean up posts that have already been published to Twitter
    await cleanupPublishedPosts();

    // 2. Check current Buffer queue count and last scheduled time
    const bufferInfo = await getBufferQueueInfo(channelId);
    const currentCount = bufferInfo.count;
    const lastScheduledAt = bufferInfo.lastScheduledAt;
    logger.info(`AutoFill: Buffer queue has ${currentCount} post(s). Last scheduled at: ${lastScheduledAt || 'none'}`);

    if (currentCount >= postQueue.BUFFER_MAX_QUEUE) {
      logger.info(`AutoFill: queue is full (${currentCount}/${postQueue.BUFFER_MAX_QUEUE}) — no refill needed`);
      return;
    }

    // 3. How many slots to fill
    const slotsToFill = postQueue.BUFFER_MAX_QUEUE - currentCount;
    logger.info(`AutoFill: need to fill ${slotsToFill} slot(s)`);

    // 4. Get pending posts from queue
    const pending = postQueue.getPendingPosts(channelId);
    if (pending.length === 0) {
      logger.info(`AutoFill: no pending posts in queue for channel ${channelId} — nothing to schedule`);
      return;
    }

    const toSchedule = pending.slice(0, slotsToFill);
    logger.info(`AutoFill: scheduling ${toSchedule.length} post(s) from queue`);

    // 4. Calculate posting times
    const minSpacing = parseInt(process.env.MIN_SPACING_MINUTES || '60', 10);
    const maxSpacing = parseInt(process.env.MAX_SPACING_MINUTES || '90', 10);

    // If Buffer has existing scheduled posts, start scheduling AFTER the last post in queue
    let baseTime;
    if (lastScheduledAt && new Date(lastScheduledAt) > new Date()) {
      baseTime = skipBlackout(new Date(lastScheduledAt));
      logger.info(`AutoFill: continuing schedule AFTER last post in Buffer: ${baseTime.toISOString()}`);
    } else {
      baseTime = skipBlackout(new Date());
      logger.info(`AutoFill: queue was empty or last post passed — starting schedule from now: ${baseTime.toISOString()}`);
    }

    const dryRun = process.env.DRY_RUN === 'true';
    const axios = require('axios');
    const pRetry = require('p-retry').default;

    const BUFFER_GRAPHQL_URL = 'https://api.buffer.com/graphql';
    const token = process.env.BUFFER_ACCESS_TOKEN;

    for (let i = 0; i < toSchedule.length; i++) {
      const post = toSchedule[i];

      // Calculate time: first post goes out after min spacing from now
      const scheduledAt = nextPostTime(baseTime, minSpacing, maxSpacing);
      baseTime = scheduledAt;

      if (dryRun) {
        logger.info(
          `[DRY RUN] AutoFill: would schedule post #${post.index} at ${scheduledAt.toISOString()}\n` +
          `"${post.text.slice(0, 100)}..."`
        );
        postQueue.markScheduled([post.index], [{ scheduledAt: scheduledAt.toISOString() }]);
      } else {
        // Quick 250ms spacing between posts
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 250));
        }

        try {
          const res = await pRetry(
            async () => {
              try {
                const result = await axios.post(
                  BUFFER_GRAPHQL_URL,
                  {
                    query: `
                      mutation {
                        createPost(input: {
                          channelId: "${channelId}"
                          text: ${JSON.stringify(post.text)}
                          schedulingType: automatic
                          mode: customScheduled
                          dueAt: "${scheduledAt.toISOString()}"
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

                if (result.data.errors) {
                  throw new Error(result.data.errors.map(e => e.message).join('; '));
                }

                const createResult = result.data.data.createPost;
                if (createResult.message) {
                  throw new Error(`Buffer mutation error: ${createResult.message}`);
                }
                return createResult.post;
              } catch (postErr) {
                if (postErr.response && postErr.response.status === 429) {
                  const retrySec = parseInt(postErr.response.headers['retry-after'] || '6', 10);
                  logger.warn(`AutoFill: Buffer 429 Rate Limit hit — waiting ${retrySec}s...`);
                  await new Promise(r => setTimeout(r, retrySec * 1000));
                }
                throw postErr;
              }
            },
            {
              retries: 1,
              minTimeout: 1000,
              factor: 1.5,
              onFailedAttempt: (err) => {
                logger.warn(`AutoFill: attempt ${err.attemptNumber} for post #${post.index} failed: ${err.message}`);
              },
            }
          );

          logger.info(`AutoFill: ✅ scheduled post #${post.index} (id: ${res.id}) at ${res.dueAt}`);
          postQueue.markScheduled([post.index], [{
            bufferPostId: res.id,
            scheduledAt: res.dueAt,
          }]);

        } catch (err) {
          const is429 = err.response?.status === 429 || (err.message && err.message.includes('429'));
          if (is429) {
            logger.warn(`AutoFill: ⚠️ Buffer 429 rate limit reached. Halting refill run; remaining posts safely kept in queue.`);
            break; // Stop trying this cycle, posts remain safe in queue for next cycle!
          } else {
            logger.error(`AutoFill: ❌ failed to schedule post #${post.index} — ${err.message}`);
            postQueue.markError(post.index, err.message);
          }
        }
      }
    }

    const stats = postQueue.getStats();
    if (toSchedule.length > 0) {
      clearBufferCache();
    }
    logger.info(`AutoFill: done — ${stats.scheduled} scheduled, ${stats.pending} pending, ${stats.errored} errored`);

  } catch (err) {
    logger.error(`AutoFill: error — ${err.message}`, err);
  } finally {
    isRefilling = false;
  }
}

// ── Cron ─────────────────────────────────────────────────────────────────

/**
 * Start the auto-fill cron. Default runs every 6 hours (keeps Buffer at 10 posts).
 */
function startAutoFillCron() {
  const cronExpr = process.env.AUTOFILL_CRON || '0 */6 * * *';
  logger.info(`AutoFill: starting cron with schedule "${cronExpr}" (keeps Buffer at 10 posts)`);

  const task = cron.schedule(cronExpr, async () => {
    logger.info('AutoFill: ⏰ Scheduled cron triggered — checking queue...');
    try {
      await autoFillQueue();
    } catch (err) {
      logger.error(`AutoFill: ❌ Error during cron cycle — ${err.message}`, err);
    }
  }, { scheduled: true, timezone: 'Asia/Kolkata' });

  return task;
}

module.exports = { startAutoFillCron, autoFillQueue, cleanupPublishedPosts, skipBlackout, nextPostTime };
