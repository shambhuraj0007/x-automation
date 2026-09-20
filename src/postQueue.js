/**
 * src/postQueue.js
 * Local persistent queue for posts awaiting scheduling.
 *
 * All pasted posts are saved here. The auto-fill cron pulls from this queue
 * to keep Buffer at 10 scheduled posts. Persists to data/post-queue.json.
 *
 * Post states:
 *   - pending:    saved locally, not yet sent to Buffer
 *   - scheduled:  sent to Buffer and queued for publishing
 *   - published:  published by Buffer (not tracked here)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const QUEUE_FILE = path.join(process.cwd(), 'data', 'post-queue.json');
const BUFFER_MAX_QUEUE = 10;

// Ensure data directory exists
const dataDir = path.dirname(QUEUE_FILE);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// ── Read / Write ─────────────────────────────────────────────────────────

function readQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      const raw = fs.readFileSync(QUEUE_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    logger.error(`PostQueue: failed to read queue file — ${err.message}`);
  }
  return { posts: [], createdAt: null };
}

function writeQueue(queue) {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');
  } catch (err) {
    logger.error(`PostQueue: failed to write queue file — ${err.message}`);
  }
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Save a batch of posts to the local queue.
 * Replaces any existing queue.
 *
 * @param {Array<{text: string, scheduledAt: string}>} posts
 * @param {string} [channelId]
 */
function saveBatch(posts, channelId) {
  const queue = {
    posts: posts.map((p, i) => ({
      index: i + 1,
      text: p.text,
      scheduledAt: p.scheduledAt,
      status: 'pending',       // pending | scheduled | error
      bufferPostId: null,
      channelId: channelId || null,
      error: null,
      scheduledToBufferAt: null,
    })),
    createdAt: new Date().toISOString(),
    totalCount: posts.length,
  };
  writeQueue(queue);
  logger.info(`PostQueue: saved ${posts.length} posts to local queue`);
  return queue;
}

/**
 * Append new posts to the local queue without overwriting existing ones.
 * Assigns continuous 1-based indices.
 *
 * @param {Array<{text: string, scheduledAt: string}>} newPosts
 * @param {string} [channelId]
 */
function appendBatch(newPosts, channelId) {
  const queue = readQueue();
  const existingPosts = queue.posts || [];
  const startIndex = existingPosts.length;

  const mapped = newPosts.map((p, i) => ({
    index: startIndex + i + 1,
    text: p.text,
    scheduledAt: p.scheduledAt,
    status: 'pending',
    bufferPostId: null,
    channelId: channelId || null,
    error: null,
    scheduledToBufferAt: null,
  }));

  queue.posts = [...existingPosts, ...mapped];
  queue.totalCount = queue.posts.length;
  if (!queue.createdAt) queue.createdAt = new Date().toISOString();
  writeQueue(queue);
  logger.info(`PostQueue: appended ${newPosts.length} posts (total in queue: ${queue.posts.length})`);
  return { queue, newItems: mapped };
}

/**
 * Get the latest/highest scheduledAt time among all posts in the local queue.
 * @param {string} [channelId]
 * @returns {string|null} ISO date string, or null
 */
function getHighestScheduledTime(channelId) {
  const queue = readQueue();
  const posts = queue.posts || [];
  let maxDate = null;

  for (const post of posts) {
    if (channelId && post.channelId && post.channelId !== channelId) continue;
    if (post.scheduledAt) {
      const d = new Date(post.scheduledAt);
      if (!isNaN(d.getTime())) {
        if (!maxDate || d > maxDate) {
          maxDate = d;
        }
      }
    }
  }

  return maxDate ? maxDate.toISOString() : null;
}

/**
 * Clear the queue.
 * @param {string} [channelId]
 */
function clearQueue(channelId) {
  if (!channelId) {
    const queue = { posts: [], createdAt: null, totalCount: 0 };
    writeQueue(queue);
    logger.info('PostQueue: queue cleared completely');
    return queue;
  }
  const queue = readQueue();
  const remaining = (queue.posts || []).filter(p => p.channelId && p.channelId !== channelId);
  queue.posts = remaining;
  queue.totalCount = remaining.length;
  writeQueue(queue);
  logger.info(`PostQueue: cleared queue for channel ${channelId}`);
  return queue;
}

/**
 * Get posts that are still pending (not yet sent to Buffer).
 * @param {string} [channelId]
 * @returns {Array}
 */
function getPendingPosts(channelId) {
  const queue = readQueue();
  const posts = queue.posts || [];
  return posts.filter(p => p.status === 'pending' && (!channelId || !p.channelId || p.channelId === channelId));
}

/**
 * Get all posts with their statuses.
 * @param {string} [channelId]
 * @returns {Array}
 */
function getAllPosts(channelId) {
  const queue = readQueue();
  const posts = queue.posts || [];
  if (!channelId) return posts;
  return posts.filter(p => !p.channelId || p.channelId === channelId);
}

/**
 * Mark specific posts as scheduled (after successfully sending to Buffer).
 * @param {number[]} indices  - The 1-based post indices to mark
 * @param {Object[]} results  - Array of { bufferPostId, scheduledAt } per post
 */
function markScheduled(indices, results) {
  const queue = readQueue();
  indices.forEach((idx, i) => {
    const post = queue.posts.find(p => p.index === idx);
    if (post) {
      post.status = 'scheduled';
      post.bufferPostId = results[i]?.bufferPostId || null;
      post.scheduledAt = results[i]?.scheduledAt || post.scheduledAt;
      post.scheduledToBufferAt = new Date().toISOString();
    }
  });
  writeQueue(queue);
}

/**
 * Mark a specific post as errored.
 * @param {number} index
 * @param {string} error
 */
function markError(index, error) {
  const queue = readQueue();
  const post = queue.posts.find(p => p.index === index);
  if (post) {
    post.status = 'error';
    post.error = error;
  }
  writeQueue(queue);
}

/**
 * Get queue summary stats.
 * @param {string} [channelId]
 */
function getStats(channelId) {
  const queue = readQueue();
  const allPosts = queue.posts || [];
  const posts = channelId ? allPosts.filter(p => !p.channelId || p.channelId === channelId) : allPosts;
  return {
    total: posts.length,
    pending: posts.filter(p => p.status === 'pending').length,
    scheduled: posts.filter(p => p.status === 'scheduled').length,
    errored: posts.filter(p => p.status === 'error').length,
    createdAt: queue.createdAt,
  };
}

module.exports = {
  BUFFER_MAX_QUEUE,
  saveBatch,
  appendBatch,
  getHighestScheduledTime,
  clearQueue,
  getPendingPosts,
  getAllPosts,
  markScheduled,
  markError,
  getStats,
  readQueue,
};
