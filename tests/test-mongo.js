'use strict';

require('dotenv').config();
const { MongoClient } = require('mongodb');

async function testConnection() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;

  if (!uri) {
    console.log('❌ No MONGODB_URI or MONGO_URI found in .env file.');
    console.log('Please ensure you have saved .env (Ctrl + S) with:');
    console.log('MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority');
    return;
  }

  // Mask credentials for display
  const maskedUri = uri.replace(/\/\/(.*?)@/, '//***:***@');
  console.log(`Connecting to: ${maskedUri}...`);

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 7000,
    connectTimeoutMS: 10000,
  });

  try {
    await client.connect();
    // Ping admin database
    const pingResult = await client.db('admin').command({ ping: 1 });
    console.log('✅ MongoDB connection successful!');
    console.log('Ping response:', pingResult);

    // Test write and read on the application database
    const dbName = process.env.MONGODB_DB_NAME || 'twitter_automation';
    const db = client.db(dbName);
    const testColl = db.collection('_connection_test');
    await testColl.insertOne({ test: true, timestamp: new Date() });
    await testColl.deleteOne({ test: true });
    console.log(`✅ Read/Write permissions verified on database "${dbName}".`);

    await client.close();
  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
  }
}

testConnection();
