/**
 * tests/test.js
 * Unit tests — run with: node tests/test.js
 * No external API calls are made.
 */

'use strict';

// Set up a minimal env for testing
process.env.DRY_RUN = 'true';
process.env.LOG_LEVEL = 'warn';
process.env.GEMINI_API_KEY = 'test_key';
process.env.BUFFER_ACCESS_TOKEN = 'test_token';
process.env.BUFFER_PROFILE_ID = 'test_profile';
process.env.TWEET_NICHE = 'AI and technology';

const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}\n     ${err.message}`);
    failed++;
  }
}

// ── Prompt tests ─────────────────────────────────────────────────────────────
console.log('\n📝 Prompt module:');
const { buildPrompt, parseResponse } = require('../src/prompt');

test('buildPrompt returns a non-empty string', () => {
  const p = buildPrompt({ niche: 'AI', subtopics: ['machine learning'], recentTopics: [], count: 3 });
  assert.ok(typeof p === 'string' && p.length > 100, 'Prompt should be substantial');
});

test('buildPrompt includes the niche', () => {
  const p = buildPrompt({ niche: 'TestNiche42', subtopics: [], recentTopics: [], count: 3 });
  assert.ok(p.includes('TestNiche42'), 'Prompt should contain the niche');
});

test('buildPrompt includes recent topics in avoid section', () => {
  const p = buildPrompt({ niche: 'AI', subtopics: [], recentTopics: ['do not repeat this'], count: 3 });
  assert.ok(p.includes('do not repeat this'), 'Should include recent topics to avoid');
});

test('parseResponse parses tweets correctly', () => {
  const raw = 'First tweet here\n---TWEET---\nSecond tweet here\n---TWEET---\nThird tweet here\n---TOPICS---\ntopic1, topic2';
  const { tweets, topics } = parseResponse(raw);
  assert.strictEqual(tweets.length, 3, 'Should parse 3 tweets');
  assert.strictEqual(topics.length, 2, 'Should parse 2 topics');
  assert.strictEqual(tweets[0].text, 'First tweet here');
  assert.strictEqual(topics[0], 'topic1');
});

test('parseResponse handles missing TOPICS section', () => {
  const raw = 'Tweet A\n---TWEET---\nTweet B';
  const { tweets, topics } = parseResponse(raw);
  assert.strictEqual(tweets.length, 2);
  assert.strictEqual(topics.length, 0);
});

// ── Topic registry tests ──────────────────────────────────────────────────────
console.log('\n🗂  Topic registry:');

// Build a lightweight in-memory registry instance to avoid singleton/fs coupling
function makeTestRegistry() {
  const registry = {
    topics: new Map(),
    memoryDays: 7,
    _normalize(topic) { return topic.toLowerCase().trim().replace(/[^\w\s]/g, ''); },
    isDuplicate(topic) {
      const key = this._normalize(topic);
      if (this.topics.has(key)) return true;
      const newWords = new Set(key.split(/\s+/).filter(w => w.length > 3));
      for (const stored of this.topics.keys()) {
        const storedWords = stored.split(/\s+/).filter(w => w.length > 3);
        const overlap = storedWords.filter(w => newWords.has(w)).length;
        if (overlap >= 2) return true;
      }
      return false;
    },
  };
  return registry;
}

test('isDuplicate returns false for new topic', () => {
  const reg = makeTestRegistry();
  assert.strictEqual(reg.isDuplicate('brand new topic xyz'), false);
});

test('isDuplicate returns true for exact registered topic', () => {
  const reg = makeTestRegistry();
  reg.topics.set('artificial intelligence trends', Date.now());
  assert.strictEqual(reg.isDuplicate('artificial intelligence trends'), true);
});

test('isDuplicate detects fuzzy duplicates', () => {
  const reg = makeTestRegistry();
  reg.topics.set('future artificial intelligence systems', Date.now());
  // Shares "artificial" and "intelligence" — should be flagged
  assert.strictEqual(reg.isDuplicate('artificial intelligence revolution'), true);
});

// ── Buffer spacing tests ──────────────────────────────────────────────────────
console.log('\n⏱  Buffer spacing:');
const { nextScheduledTime } = require('../src/buffer');

process.env.MIN_SPACING_MINUTES = '45';
process.env.MAX_SPACING_MINUTES = '120';

test('nextScheduledTime is within 45-120 min of base', () => {
  const base = new Date();
  const next = nextScheduledTime(base);
  const diffMins = (next - base) / 1000 / 60;
  assert.ok(diffMins >= 45 && diffMins <= 120, `Expected 45–120 min, got ${diffMins.toFixed(1)}`);
});

test('nextScheduledTime is strictly after base', () => {
  const base = new Date();
  const next = nextScheduledTime(base);
  assert.ok(next > base, 'Next time must be in the future');
});

test('nextScheduledTime generates different values (randomness check)', () => {
  const base = new Date();
  const times = Array.from({ length: 10 }, () => nextScheduledTime(base).getTime());
  const unique = new Set(times).size;
  assert.ok(unique > 1, 'Expected some variance in scheduled times');
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('⚠️  Some tests failed.');
  process.exit(1);
} else {
  console.log('🎉 All tests passed!');
}
