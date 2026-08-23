/**
 * src/topicRegistry.js
 * Tracks recently used tweet topics to prevent duplicate/repetitive content.
 * Persists to disk so memory survives daemon restarts.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA_DIR = path.join(process.cwd(), 'data');
const REGISTRY_FILE = path.join(DATA_DIR, 'topics.json');

class TopicRegistry {
  constructor() {
    this.memoryDays = parseInt(process.env.TOPIC_MEMORY_DAYS || '7', 10);
    this.topics = new Map(); // topic → timestamp
    this._ensureDataDir();
    this._load();
  }

  /**
   * Register a batch of topics as recently used.
   * @param {string[]} topics
   */
  register(topics) {
    const now = Date.now();
    for (const topic of topics) {
      const key = this._normalize(topic);
      this.topics.set(key, now);
    }
    this._save();
    logger.debug(`TopicRegistry: registered ${topics.length} topics. Total tracked: ${this.topics.size}`);
  }

  /**
   * Returns all recently used topics as an array (for injection into prompt).
   * @returns {string[]}
   */
  getRecent() {
    this._pruneExpired();
    return Array.from(this.topics.keys());
  }

  /**
   * Check whether a topic is too similar to a recently used one.
   * @param {string} topic
   * @returns {boolean}
   */
  isDuplicate(topic) {
    this._pruneExpired();
    const key = this._normalize(topic);
    // Exact match
    if (this.topics.has(key)) return true;
    // Fuzzy match — check if any stored topic shares ≥2 words
    const newWords = new Set(key.split(/\s+/).filter(w => w.length > 3));
    for (const stored of this.topics.keys()) {
      const storedWords = stored.split(/\s+/).filter(w => w.length > 3);
      const overlap = storedWords.filter(w => newWords.has(w)).length;
      if (overlap >= 2) return true;
    }
    return false;
  }

  // ── Private ──────────────────────────────────────────────────

  _normalize(topic) {
    return topic.toLowerCase().trim().replace(/[^\w\s]/g, '');
  }

  _pruneExpired() {
    const cutoff = Date.now() - this.memoryDays * 24 * 60 * 60 * 1000;
    let pruned = 0;
    for (const [key, ts] of this.topics.entries()) {
      if (ts < cutoff) {
        this.topics.delete(key);
        pruned++;
      }
    }
    if (pruned > 0) {
      logger.debug(`TopicRegistry: pruned ${pruned} expired topics`);
      this._save();
    }
  }

  _ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  _load() {
    try {
      if (fs.existsSync(REGISTRY_FILE)) {
        const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
        this.topics = new Map(Object.entries(raw));
        this._pruneExpired();
        logger.debug(`TopicRegistry: loaded ${this.topics.size} topics from disk`);
      }
    } catch (err) {
      logger.warn(`TopicRegistry: failed to load from disk — starting fresh. ${err.message}`);
      this.topics = new Map();
    }
  }

  _save() {
    try {
      const obj = Object.fromEntries(this.topics);
      fs.writeFileSync(REGISTRY_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (err) {
      logger.warn(`TopicRegistry: failed to persist to disk. ${err.message}`);
    }
  }
}

// Singleton
module.exports = new TopicRegistry();
