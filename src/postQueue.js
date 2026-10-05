/**
 * src/postQueue.js
 * Persistent queue for posts awaiting scheduling.
 *
 * Each post is stored as its OWN document in MongoDB 'posts' collection.
 * Local JSON file (data/post-queue.json) is used as fallback only when
 * MongoDB is unavailable.
 *
 * Post states:
 *   - pending:    saved in DB, not yet sent to Buffer
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

const POSTS_COLLECTION = 'posts';
const HISTORY_COLLECTION = 'history';

// Ensure data directory exists for local fallback
const dataDir = path.dirname(QUEUE_FILE);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// In-memory cache for fast synchronous reads
let cachedPosts = [];

/**
 * Default fallback channel ID from environment or primary channel.
 */
function getDefaultChannelId() {
  return process.env.BUFFER_CHANNEL_ID || '6ab9f0c0ea19ca0bde0e370e';
}

/**
 * Check if a post belongs to a specified channelId.
 * If channelId is null/undefined, matches all.
 * Posts without explicit channelId belong to the default channel.
 *
 * @param {Object} post
 * @param {string} [channelId]
 * @returns {boolean}
 */
function postMatchesChannel(post, channelId) {
  if (!channelId) return true;
  const postChan = post.channelId || getDefaultChannelId();
  return postChan === channelId;
}

// ── Read / Write Local File Helpers (Fallback) ────────────────────────────

function readQueueFromFile() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      const raw = fs.readFileSync(QUEUE_FILE, 'utf-8');
      const data = JSON.parse(raw);
      return data.posts || [];
    }
  } catch (err) {
    logger.error(`PostQueue: failed to read local queue file — ${err.message}`);
  }
  return [];
}

function writeQueueToFile(posts) {
  try {
    const data = {
      posts,
      createdAt: posts.length > 0 ? posts[0].createdAt || new Date().toISOString() : null,
      totalCount: posts.length,
    };
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    logger.error(`PostQueue: failed to write local queue file — ${err.message}`);
  }
}

// ── MongoDB Document Helpers ──────────────────────────────────────────────

/**
 * Persist cached posts to MongoDB and local file.
 * MongoDB stores each post as its own document.
 */
async function persistAll() {
  // Always write local backup
  writeQueueToFile(cachedPosts);

  if (!hasMongo()) return;

  try {
    const db = getDb();
    const col = db.collection(POSTS_COLLECTION);

    // Get all active posts (not published) from cache
    const activePosts = cachedPosts.filter(p => p.status !== 'published');

    // Upsert each post individually by its unique _postId
    const ops = activePosts.map(post => ({
      updateOne: {
        filter: { _postId: post._postId },
        update: { $set: { ...post, updatedAt: new Date().toISOString() } },
        upsert: true,
      },
    }));

    if (ops.length > 0) {
      await col.bulkWrite(ops, { ordered: false });
    }
  } catch (err) {
    logger.warn(`PostQueue: MongoDB persist error — ${err.message}`);
  }
}

/**
 * Persist a single post to MongoDB (for fast individual updates).
 */
async function persistOne(post) {
  if (!hasMongo()) return;
  try {
    const db = getDb();
    await db.collection(POSTS_COLLECTION).updateOne(
      { _postId: post._postId },
      { $set: { ...post, updatedAt: new Date().toISOString() } },
      { upsert: true }
    );
  } catch (err) {
    logger.warn(`PostQueue: MongoDB single persist error — ${err.message}`);
  }
}

/**
 * Remove a post from MongoDB by its _postId.
 */
async function removeFromMongo(postId) {
  if (!hasMongo()) return;
  try {
    const db = getDb();
    await db.collection(POSTS_COLLECTION).deleteOne({ _postId: postId });
  } catch (err) {
    logger.warn(`PostQueue: MongoDB remove error — ${err.message}`);
  }
}

// ── MongoDB Sync on Startup ──────────────────────────────────────────────

/**
 * Sync queue state with MongoDB on startup.
 * MongoDB is the source of truth if it has data.
 */
async function syncWithMongo() {
  if (!hasMongo()) {
    cachedPosts = readQueueFromFile().filter(p => p.status !== 'scheduled' && p.status !== 'published');
    logger.info(`PostQueue: loaded ${cachedPosts.length} post(s) from local file (no MongoDB)`);
    return cachedPosts;
  }

  try {
    const db = getDb();
    const col = db.collection(POSTS_COLLECTION);

    // Purge any lingering 'scheduled' or 'published' posts from MongoDB so they are not retained anywhere
    try {
      const staleRes = await col.deleteMany({ status: { $in: ['scheduled', 'published'] } });
      if (staleRes.deletedCount > 0) {
        logger.info(`PostQueue: 🗑️ Purged ${staleRes.deletedCount} previously scheduled/published post(s) from MongoDB`);
      }
    } catch (cleanErr) {
      logger.debug(`PostQueue: stale cleanup notice — ${cleanErr.message}`);
    }

    // Fetch all non-published, non-scheduled posts from MongoDB
    const mongoPosts = await col.find({
      status: { $in: ['pending', 'error'] },
    }).sort({ index: 1 }).toArray();

    if (mongoPosts.length > 0) {
      // MongoDB has data — use it as source of truth
      cachedPosts = mongoPosts.map(doc => {
        const { _id, ...rest } = doc;
        if (!rest.channelId) {
          rest.channelId = getDefaultChannelId();
        }
        return rest;
      });
      writeQueueToFile(cachedPosts);
      logger.info(`PostQueue: ✅ Restored ${cachedPosts.length} post(s) from MongoDB`);
    } else {
      // MongoDB is empty — check local file for migration
      const localPosts = readQueueFromFile().filter(p => p.status !== 'scheduled' && p.status !== 'published');
      if (localPosts.length > 0) {
        // Ensure each post has a _postId
        localPosts.forEach((p, i) => {
          if (!p._postId) {
            p._postId = `post_${Date.now()}_${i}`;
          }
        });
        cachedPosts = localPosts;

        // Migrate to MongoDB
        const ops = localPosts.map(post => ({
          updateOne: {
            filter: { _postId: post._postId },
            update: { $set: { ...post, migratedAt: new Date().toISOString() } },
            upsert: true,
          },
        }));
        await col.bulkWrite(ops, { ordered: false });
        logger.info(`PostQueue: 🚀 Migrated ${localPosts.length} local posts into MongoDB (individual docs)`);
      } else {
        cachedPosts = [];
        logger.info('PostQueue: MongoDB and local file are both empty — clean start');
      }
    }

    // Also migrate old single-document format if it exists
    const oldDoc = await db.collection('queue').findOne({ _id: 'post_queue' });
    if (oldDoc && Array.isArray(oldDoc.posts) && oldDoc.posts.length > 0) {
      logger.info(`PostQueue: Found ${oldDoc.posts.length} posts in old 'queue' collection — migrating...`);
      const oldPosts = oldDoc.posts.filter(p => p.status !== 'published' && p.status !== 'scheduled');
      for (const p of oldPosts) {
        if (!p._postId) p._postId = `migrated_${Date.now()}_${p.index}`;
        // Only migrate if not already present
        const exists = cachedPosts.find(cp => cp.text === p.text && cp.scheduledAt === p.scheduledAt);
        if (!exists) {
          cachedPosts.push(p);
          await persistOne(p);
        }
      }
      // Remove old format
      await db.collection('queue').deleteOne({ _id: 'post_queue' });
      writeQueueToFile(cachedPosts);
      logger.info(`PostQueue: ✅ Old queue collection migrated and cleaned up`);
    }

  } catch (err) {
    logger.warn(`PostQueue: MongoDB sync error (${err.message}) — using local queue file`);
    cachedPosts = readQueueFromFile().filter(p => p.status !== 'scheduled' && p.status !== 'published');
  }

  return cachedPosts;
}

// ── Read / Write API ──────────────────────────────────────────────────────

function readQueue() {
  // Return in the old format for backward compatibility with autoFill.js
  return {
    posts: cachedPosts,
    createdAt: cachedPosts.length > 0 ? cachedPosts[0].createdAt : null,
    totalCount: cachedPosts.length,
  };
}

function writeQueue(queue) {
  cachedPosts = queue.posts || [];
  writeQueueToFile(cachedPosts);

  // Persist to MongoDB asynchronously
  if (hasMongo()) {
    persistAll().catch(err => {
      logger.warn(`PostQueue: MongoDB async write error — ${err.message}`);
    });
  }
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Generate a unique post ID.
 */
function generatePostId() {
  return `post_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Save a batch of posts (replaces queue).
 * Each post becomes its own document in MongoDB.
 *
 * @param {Array<{text: string, scheduledAt: string}>} posts
 * @param {string} [channelId]
 */
async function saveBatch(posts, channelId) {
  const targetChannel = channelId || getDefaultChannelId();
  const now = new Date().toISOString();
  cachedPosts = posts.map((p, i) => ({
    _postId: generatePostId(),
    index: i + 1,
    text: p.text,
    scheduledAt: p.scheduledAt,
    status: 'pending',
    bufferPostId: null,
    channelId: targetChannel,
    error: null,
    scheduledToBufferAt: null,
    createdAt: now,
  }));

  writeQueueToFile(cachedPosts);

  // Persist to MongoDB: clear old posts, insert new
  if (hasMongo()) {
    try {
      const db = getDb();
      const col = db.collection(POSTS_COLLECTION);
      if (channelId) {
        await col.deleteMany({ channelId, status: { $in: ['pending', 'error'] } });
      } else {
        await col.deleteMany({ status: { $in: ['pending', 'error'] } });
      }
      if (cachedPosts.length > 0) {
        await col.insertMany(cachedPosts.map(p => ({ ...p })));
      }
      logger.info(`PostQueue: saved ${cachedPosts.length} posts to MongoDB (individual docs)`);
    } catch (err) {
      logger.warn(`PostQueue: MongoDB saveBatch error — ${err.message}`);
    }
  }

  logger.info(`PostQueue: saved ${posts.length} posts to queue`);
  return { posts: cachedPosts };
}

/**
 * Append new posts to the queue without overwriting existing ones.
 * Each new post gets its own MongoDB document.
 *
 * @param {Array<{text: string, scheduledAt: string}>} newPosts
 * @param {string} [channelId]
 */
async function appendBatch(newPosts, channelId) {
  const targetChannel = channelId || getDefaultChannelId();
  const now = new Date().toISOString();
  const startIndex = cachedPosts.length;

  const mapped = newPosts.map((p, i) => ({
    _postId: generatePostId(),
    index: startIndex + i + 1,
    text: p.text,
    scheduledAt: p.scheduledAt,
    status: 'pending',
    bufferPostId: null,
    channelId: targetChannel,
    error: null,
    scheduledToBufferAt: null,
    createdAt: now,
  }));

  cachedPosts = [...cachedPosts, ...mapped];
  writeQueueToFile(cachedPosts);

  // Insert new docs into MongoDB
  if (hasMongo()) {
    try {
      const db = getDb();
      await db.collection(POSTS_COLLECTION).insertMany(mapped.map(p => ({ ...p })));
      logger.info(`PostQueue: inserted ${mapped.length} new post docs into MongoDB`);
    } catch (err) {
      logger.warn(`PostQueue: MongoDB appendBatch error — ${err.message}`);
    }
  }

  logger.info(`PostQueue: appended ${newPosts.length} posts (total: ${cachedPosts.length})`);
  return { queue: { posts: cachedPosts, totalCount: cachedPosts.length }, newItems: mapped };
}

/**
 * Get the latest/highest scheduledAt time among all posts in the queue.
 * @param {string} [channelId]
 * @returns {string|null} ISO date string, or null
 */
function getHighestScheduledTime(channelId) {
  let maxDate = null;
  for (const post of cachedPosts) {
    if (!postMatchesChannel(post, channelId)) continue;
    if (post.scheduledAt) {
      const d = new Date(post.scheduledAt);
      if (!isNaN(d.getTime())) {
        if (!maxDate || d > maxDate) maxDate = d;
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
    // Remove all non-published from MongoDB
    if (hasMongo()) {
      const db = getDb();
      db.collection(POSTS_COLLECTION).deleteMany({
        status: { $in: ['pending', 'scheduled', 'error'] },
      }).catch(err => logger.warn(`PostQueue: MongoDB clearQueue error — ${err.message}`));
    }
    cachedPosts = [];
    writeQueueToFile(cachedPosts);
    logger.info('PostQueue: queue cleared completely');
    return { posts: [], createdAt: null, totalCount: 0 };
  }

  // Remove only posts for this channel
  const toRemove = cachedPosts.filter(p => postMatchesChannel(p, channelId) && p.status !== 'published');
  cachedPosts = cachedPosts.filter(p => !postMatchesChannel(p, channelId) || p.status === 'published');

  if (hasMongo() && toRemove.length > 0) {
    const db = getDb();
    const ids = toRemove.map(p => p._postId).filter(Boolean);
    if (ids.length > 0) {
      db.collection(POSTS_COLLECTION).deleteMany({ _postId: { $in: ids } })
        .catch(err => logger.warn(`PostQueue: MongoDB clearQueue (channel) error — ${err.message}`));
    }
  }

  writeQueueToFile(cachedPosts);
  logger.info(`PostQueue: cleared queue for channel ${channelId}`);
  return { posts: cachedPosts, totalCount: cachedPosts.length };
}

/**
 * Get posts that are still pending (not yet sent to Buffer).
 * @param {string} [channelId]
 * @returns {Array}
 */
function getPendingPosts(channelId) {
  return cachedPosts.filter(p =>
    p.status === 'pending' && postMatchesChannel(p, channelId)
  );
}

/**
 * Get all active posts with their statuses.
 * @param {string} [channelId]
 * @returns {Array}
 */
function getAllPosts(channelId) {
  if (!channelId) return cachedPosts;
  return cachedPosts.filter(p => postMatchesChannel(p, channelId));
}

/**
 * As soon as posts are scheduled in Buffer, delete them from everywhere:
 * in-memory cache, local JSON queue file, and MongoDB.
 *
 * @param {number[]} indices  - The 1-based post indices to delete
 * @param {Object[]} [results] - Optional results metadata
 */
async function markScheduled(indices, results) {
  const idsToDelete = [];
  indices.forEach(idx => {
    const post = cachedPosts.find(p => p.index === idx);
    if (post && post._postId) {
      idsToDelete.push(post._postId);
    }
  });

  if (idsToDelete.length > 0) {
    logger.info(`PostQueue: 🗑️ Deleting ${idsToDelete.length} post(s) from everywhere as they are now scheduled in Buffer`);
    await deletePosts(idsToDelete);
  }
}

/**
 * Mark a specific post as errored.
 * @param {number} index
 * @param {string} error
 */
function markError(index, error) {
  const post = cachedPosts.find(p => p.index === index);
  if (post) {
    post.status = 'error';
    post.error = error;
    persistOne(post).catch(() => {});
  }
  writeQueueToFile(cachedPosts);
}

/**
 * Get queue summary stats.
 * @param {string} [channelId]
 */
function getStats(channelId) {
  const posts = channelId
    ? cachedPosts.filter(p => postMatchesChannel(p, channelId))
    : cachedPosts;
  return {
    total: posts.length,
    pending: posts.filter(p => p.status === 'pending').length,
    scheduled: posts.filter(p => p.status === 'scheduled').length,
    errored: posts.filter(p => p.status === 'error').length,
    createdAt: posts.length > 0 ? posts[0].createdAt : null,
  };
}

/**
 * Get posts that have been scheduled to Buffer.
 * @param {string} [channelId]
 * @returns {Array}
 */
function getScheduledPosts(channelId) {
  return cachedPosts.filter(p =>
    p.status === 'scheduled' && postMatchesChannel(p, channelId)
  );
}

/**
 * Mark specific posts as published (already sent to Twitter by Buffer).
 * @param {number[]} indices - The 1-based post indices to mark
 */
function markPublished(indices) {
  indices.forEach(idx => {
    const post = cachedPosts.find(p => p.index === idx);
    if (post) {
      post.status = 'published';
      post.publishedAt = new Date().toISOString();
      persistOne(post).catch(() => {});
    }
  });
  writeQueueToFile(cachedPosts);
  if (indices.length > 0) {
    logger.info(`PostQueue: marked ${indices.length} post(s) as published`);
  }
}

/**
 * Archive published posts to MongoDB 'history' collection and data/history.json.
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
    db.collection(HISTORY_COLLECTION).insertMany(docs).catch(err => {
      logger.warn(`PostQueue: MongoDB archive history failed — ${err.message}`);
    });
  }
}

/**
 * Get published post history.
 * Prefers MongoDB, falls back to local file.
 * @param {string} [channelId]
 * @returns {Array}
 */
function getHistory(channelId) {
  // TODO: Add async MongoDB history fetch for API route
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
      if (!channelId) return history;
      return history.filter(p => postMatchesChannel(p, channelId));
    }
  } catch (err) {
    logger.warn(`PostQueue: failed to read history — ${err.message}`);
  }
  return [];
}

/**
 * Remove all posts with status "published" from the queue & MongoDB.
 * Archives them to history first.
 * @param {string} [channelId]
 * @returns {number} Number of posts removed
 */
async function removePublishedPosts(channelId) {
  const before = cachedPosts.length;

  const published = cachedPosts.filter(p => {
    if (p.status !== 'published') return false;
    if (channelId && !postMatchesChannel(p, channelId)) return false;
    return true;
  });

  if (published.length > 0) {
    appendHistory(published);

    // Remove from MongoDB
    if (hasMongo()) {
      const db = getDb();
      const ids = published.map(p => p._postId).filter(Boolean);
      if (ids.length > 0) {
        try {
          await db.collection(POSTS_COLLECTION).deleteMany({ _postId: { $in: ids } });
        } catch (err) {
          logger.warn(`PostQueue: MongoDB remove published error — ${err.message}`);
        }
      }
    }
  }

  cachedPosts = cachedPosts.filter(p => {
    if (p.status !== 'published') return true;
    if (channelId && !postMatchesChannel(p, channelId)) return true;
    return false;
  });

  const removed = before - cachedPosts.length;
  writeQueueToFile(cachedPosts);
  if (removed > 0) {
    logger.info(`PostQueue: removed ${removed} published post(s) from queue`);
  }
  return removed;
}

/**
 * Check if an error message is the Buffer "duplicate post" error.
 * @param {string} errorMsg
 * @returns {boolean}
 */
function isDuplicatePostError(errorMsg) {
  if (!errorMsg) return false;
  return /already got this one scheduled or posted around the same time/i.test(errorMsg) ||
         /not able to post the same thing twice/i.test(errorMsg);
}

/**
 * Delete multiple posts by _postId from in-memory cache, MongoDB, and local file.
 *
 * @param {string[]} postIds - Array of _postId strings
 */
async function deletePosts(postIds) {
  if (!Array.isArray(postIds) || postIds.length === 0) return;
  const idSet = new Set(postIds);
  cachedPosts = cachedPosts.filter(p => !idSet.has(p._postId));
  writeQueueToFile(cachedPosts);

  if (hasMongo()) {
    try {
      const db = getDb();
      await db.collection(POSTS_COLLECTION).deleteMany({ _postId: { $in: postIds } });
    } catch (err) {
      logger.warn(`PostQueue: MongoDB deletePosts error — ${err.message}`);
    }
  }
}

/**
 * Delete a single post by _postId from in-memory cache, MongoDB, and local file.
 * Used to immediately remove posts that are scheduled to Buffer or rejected as duplicates.
 *
 * @param {string} postId - The _postId of the post to delete
 * @returns {Promise<boolean>} true if deleted
 */
async function deletePost(postId) {
  if (!postId) return false;
  const idx = cachedPosts.findIndex(p => p._postId === postId);
  if (idx !== -1) {
    const post = cachedPosts[idx];
    logger.info(`PostQueue: 🗑️ Deleting post "${postId}" (index: ${post.index}, text: "${(post.text || '').slice(0, 60)}...")`);
    cachedPosts.splice(idx, 1);
    writeQueueToFile(cachedPosts);
  } else {
    logger.debug(`PostQueue: deletePost — ensuring _postId "${postId}" removed from MongoDB`);
  }

  // Always remove from MongoDB
  await removeFromMongo(postId);
  return true;
}

/**
 * Delete a single post by its 1-based index from in-memory cache, MongoDB, and local file.
 *
 * @param {number} index - The 1-based index of the post to delete
 * @returns {Promise<boolean>} true if a post was found and deleted
 */
async function deletePostByIndex(index) {
  const post = cachedPosts.find(p => p.index === index);
  if (!post) {
    logger.debug(`PostQueue: deletePostByIndex — index ${index} not found in cache`);
    return false;
  }
  return deletePost(post._postId);
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
  deletePost,
  deletePosts,
  deletePostByIndex,
  isDuplicatePostError,
  postMatchesChannel,
  getDefaultChannelId,
};
