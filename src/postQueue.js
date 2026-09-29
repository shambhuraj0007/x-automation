/**
 * src/postQueue.js
 * Persistent queue for posts awaiting scheduling.
 *
 * All pasted posts are saved here. The auto-fill cron pulls from this queue
 * to keep Buffer at 10 scheduled posts.
 * Persists to MongoDB (primary) and data/post-queue.json (local backup).
 *
 * Post states:
 *   - pending:    saved locally / in DB, not yet sent to Buffer
 *   - scheduled:  sent to Buffer and queued for publishing
 *   - published:  published by Buffer (archived to history)
 *   - error:      failed with error message preserved
 */

'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { getDb, hasMongo } = require('./db');

const QUEUE_FILE = path.join(process.cwd(), 'data', 'post-queue.json');
const HISTORY_FILE = path.join(process.cwd(), 'data', 'history.json');
const BUFFER_MAX_QUEUE = 10;

// Ensure data directory exists for local fallback
const dataDir = path.dirname(QUEUE_FILE);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// In-memory cache to ensure synchronous reads are always instant
let cachedQueue = null;

// ── Read / Write File Helpers ─────────────────────────────────────────────

function readQueueFromFile() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      const raw = fs.readFileSync(QUEUE_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    logger.error(`PostQueue: failed to read local queue file — ${err.message}`);
  }
  return { posts: [], createdAt: null, totalCount: 0 };
}

function writeQueueToFile(queue) {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');
  } catch (err) {
    logger.error(`PostQueue: failed to write local queue file — ${err.message}`);
  }
}

// ── MongoDB Synchronization ──────────────────────────────────────────────

/**
 * Sync queue state with MongoDB on startup.
 * If MongoDB has data, it restores it into the active queue.
 * If MongoDB is empty but local file has posts, it migrates them to MongoDB.
 */
async function syncWithMongo() {
  if (!hasMongo()) {
    cachedQueue = readQueueFromFile();
    return cachedQueue;
  }

  try {
    const db = getDb();
    const doc = await db.collection('queue').findOne({ _id: 'post_queue' });

    if (doc && Array.isArray(doc.posts) && doc.posts.length > 0) {
      cachedQueue = {
        posts: doc.posts,
        createdAt: doc.createdAt || new Date().toISOString(),
        totalCount: doc.posts.length,
      };
      writeQueueToFile(cachedQueue);
      logger.info(`PostQueue: ✅ Successfully restored ${cachedQueue.posts.length} post(s) from MongoDB`);
    } else {
      // Local queue migration to MongoDB if local has data
      const local = readQueueFromFile();
      if (local && local.posts && local.posts.length > 0) {
        await db.collection('queue').replaceOne(
          { _id: 'post_queue' },
          { _id: 'post_queue', ...local },
          { upsert: true }
        );
        cachedQueue = local;
        logger.info(`PostQueue: 🚀 Migrated ${local.posts.length} local posts into MongoDB`);
      } else {
        cachedQueue = { posts: [], createdAt: null, totalCount: 0 };
      }
    }
  } catch (err) {
    logger.warn(`PostQueue: MongoDB sync error (${err.message}) — using local queue file.`);
    cachedQueue = readQueueFromFile();
  }

  return cachedQueue;
}

// ── Read / Write API ──────────────────────────────────────────────────────

function readQueue() {
  if (!cachedQueue) {
    cachedQueue = readQueueFromFile();
  }
  return cachedQueue;
}

function writeQueue(queue) {
  cachedQueue = queue;

  // 1. Write to local file as backup cache
  writeQueueToFile(queue);

  // 2. Persist to MongoDB asynchronously
  if (hasMongo()) {
    const db = getDb();
    db.collection('queue').replaceOne(
      { _id: 'post_queue' },
      { _id: 'post_queue', ...queue },
      { upsert: true }
    ).catch(err => {
      logger.warn(`PostQueue: MongoDB async write failed — ${err.message}`);
    });
  }
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Save a batch of posts to the queue.
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
  logger.info(`PostQueue: saved ${posts.length} posts to queue (MongoDB & local)`);
  return queue;
}

/**
 * Append new posts to the queue without overwriting existing ones.
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
 * Get the latest/highest scheduledAt time among all posts in the queue.
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

/**
 * Get posts that have been scheduled to Buffer.
 * @param {string} [channelId]
 * @returns {Array}
 */
function getScheduledPosts(channelId) {
  const queue = readQueue();
  const posts = queue.posts || [];
  return posts.filter(p => p.status === 'scheduled' && (!channelId || !p.channelId || p.channelId === channelId));
}

/**
 * Mark specific posts as published (already sent to Twitter by Buffer).
 * @param {number[]} indices - The 1-based post indices to mark
 */
function markPublished(indices) {
  const queue = readQueue();
  indices.forEach((idx) => {
    const post = queue.posts.find(p => p.index === idx);
    if (post) {
      post.status = 'published';
      post.publishedAt = new Date().toISOString();
    }
  });
  writeQueue(queue);
  if (indices.length > 0) {
    logger.info(`PostQueue: marked ${indices.length} post(s) as published`);
  }
}

/**
 * Archive published posts to MongoDB history collection and data/history.json.
 * @param {Array} posts
 */
function appendHistory(posts) {
  if (!posts || posts.length === 0) return;

  // 1. Local JSON file backup
  try {
    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
      try {
        history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
      } catch {
        history = [];
      }
    }
    history.push(...posts);
    if (history.length > 500) history = history.slice(history.length - 500);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
    logger.info(`PostQueue: archived ${posts.length} published post(s) to history.json`);
  } catch (err) {
    logger.warn(`PostQueue: failed to archive history locally — ${err.message}`);
  }

  // 2. MongoDB history collection
  if (hasMongo()) {
    const db = getDb();
    const docs = posts.map(p => ({
      ...p,
      archivedAt: new Date().toISOString(),
    }));
    db.collection('history').insertMany(docs).catch(err => {
      logger.warn(`PostQueue: MongoDB archive history failed — ${err.message}`);
    });
  }
}

/**
 * Get published post history.
 * @param {string} [channelId]
 * @returns {Array}
 */
function getHistory(channelId) {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
      if (!channelId) return history;
      return history.filter(p => !p.channelId || p.channelId === channelId);
    }
  } catch (err) {
    logger.warn(`PostQueue: failed to read history — ${err.message}`);
  }
  return [];
}

/**
 * Remove all posts with status "published" from the queue file & MongoDB.
 * Archives them to history.
 * @param {string} [channelId]
 * @returns {number} Number of posts removed
 */
function removePublishedPosts(channelId) {
  const queue = readQueue();
  const before = queue.posts.length;

  const published = queue.posts.filter(p => {
    if (p.status !== 'published') return false;
    if (channelId && p.channelId && p.channelId !== channelId) return false;
    return true;
  });

  if (published.length > 0) {
    appendHistory(published);
  }

  queue.posts = queue.posts.filter(p => {
    if (p.status !== 'published') return true;
    if (channelId && p.channelId && p.channelId !== channelId) return true;
    return false;
  });

  const removed = before - queue.posts.length;
  queue.totalCount = queue.posts.length;
  writeQueue(queue);
  if (removed > 0) {
    logger.info(`PostQueue: removed ${removed} published post(s) from queue`);
  }
  return removed;
}

module.exports = {
  BUFFER_MAX_QUEUE,
  syncWithMongo,
  saveBatch,
  appendBatch,
  getHighestScheduledTime,
  clearQueue,
  getPendingPosts,
  getScheduledPosts,
  getAllPosts,
  markScheduled,
  markPublished,
  markError,
  removePublishedPosts,
  getStats,
  readQueue,
  writeQueue,
  getHistory,
};
