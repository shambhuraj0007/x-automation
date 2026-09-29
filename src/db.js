'use strict';

const { MongoClient } = require('mongodb');
const logger = require('./logger');

let client = null;
let db = null;
let isConnected = false;

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || 'twitter_automation';

/**
 * Connect to MongoDB if URI is configured.
 */
async function connectDb() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    logger.info('MongoDB: No MONGODB_URI set in environment — using local JSON file persistence.');
    return null;
  }

  if (isConnected && db) return db;

  try {
    logger.info('MongoDB: Connecting to MongoDB database...');
    client = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 10000,
    });

    await client.connect();
    db = client.db(DB_NAME);
    isConnected = true;
    logger.info(`MongoDB: ✅ Successfully connected to database "${DB_NAME}"`);

    // Create indexes for efficient querying
    try {
      await db.collection('queue').createIndex({ channelId: 1 });
      await db.collection('history').createIndex({ channelId: 1, publishedAt: -1 });
    } catch (idxErr) {
      logger.debug(`MongoDB index notice: ${idxErr.message}`);
    }

    return db;
  } catch (err) {
    logger.error(`MongoDB: ❌ Connection failed (${err.message}) — continuing with local storage fallback.`);
    isConnected = false;
    db = null;
    return null;
  }
}

function getDb() {
  return db;
}

function hasMongo() {
  return isConnected && db !== null;
}

module.exports = {
  connectDb,
  getDb,
  hasMongo,
};
