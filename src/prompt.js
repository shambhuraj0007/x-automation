/**
 * src/prompt.js
 * Anti-gravity viral tweet prompt builder.
 * Generates diverse, high-engagement content across multiple formats.
 */

'use strict';

// ── Format templates ────────────────────────────────────────────────────────

const FORMATS = [
  'single punchy tweet (max 280 characters)',
  'single tweet with a bold opening hook, then 1-2 supporting lines',
  'numbered Twitter thread (4–6 tweets, each under 270 chars, format: "1/ ... 2/ ...")',
  'stat-bomb tweet (lead with a surprising statistic, then flip the narrative)',
  'hot-take / contrarian tweet (challenge a popular belief in your niche)',
  'story-hook tweet (open with "I discovered..." or "Nobody talks about..." — then deliver)',
  'listicle tweet ("5 things about X that most people get wrong:")',
  'quote-style insight tweet (wisdom-forward, share-worthy)',
  'prediction tweet ("In 3 years..." or "By 2030...")',
  'behind-the-scenes or raw truth tweet (vulnerable, relatable)',
];

const TONES = [
  'bold and confident',
  'curious and thought-provoking',
  'urgent and eye-opening',
  'wry and slightly contrarian',
  'inspiring and forward-looking',
  'data-driven but punchy',
];

/**
 * Randomly pick N items from an array.
 */
function pickRandom(arr, n = 1) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return n === 1 ? shuffled[0] : shuffled.slice(0, n);
}

/**
 * Build the anti-gravity viral tweet generation prompt.
 *
 * @param {Object} opts
 * @param {string}   opts.niche         - Main topic niche
 * @param {string[]} opts.subtopics     - Subtopics to draw from
 * @param {string[]} opts.recentTopics  - Recently used topics to avoid
 * @param {number}   opts.count         - Number of posts to generate
 * @returns {string} The full prompt string
 */
function buildPrompt({ niche, subtopics, recentTopics, count = 3 }) {
  const selectedFormats = pickRandom(FORMATS, Math.min(count, FORMATS.length));
  const selectedTones = pickRandom(TONES, Math.min(count, TONES.length));

  const subtopicList = subtopics.length > 0
    ? subtopics.join(', ')
    : niche;

  const avoidSection = recentTopics.length > 0
    ? `\n⛔ AVOID these recently used topics/angles (do NOT repeat them):\n${recentTopics.slice(-20).map(t => `  - ${t}`).join('\n')}`
    : '';

  return `You are an elite viral Twitter ghostwriter with a track record of writing tweets that get 10,000+ likes and go massively viral. You deeply understand what makes content spread: emotion, surprise, novelty, controversy, and raw truth.

Your task: Generate exactly ${count} original, high-quality tweets for a Twitter account focused on **${niche}**.

Subtopics to draw inspiration from: ${subtopicList}
${avoidSection}

━━━━━━━━━━━━━━━━━━━━━━
STRICT RULES (follow every single one):
━━━━━━━━━━━━━━━━━━━━━━
1. Each tweet must feel DIFFERENT in angle, format, and tone.
2. Open every tweet with an irresistible hook — the first line must make people STOP scrolling.
3. Never use generic advice. Be specific, counterintuitive, or surprising.
4. Use plain language. Short sentences. Active voice. Zero corporate fluff.
5. Do NOT use hashtags. Do NOT use emojis (unless one is powerful in context).
6. Each tweet must have a clear point of view — no wishy-washy opinions.
7. Threads must have a strong "1/" opener and deliver real value in every tweet.
8. Each tweet must feel like it was written by a real human expert, not a bot.
9. Make readers feel something: curiosity, surprise, urgency, inspiration, or a mild provocation.
10. DO NOT repeat any topic, angle, or format used in the avoid list above.

━━━━━━━━━━━━━━━━━━━━━━
FORMAT VARIETY (use one of these per tweet — mix them up):
━━━━━━━━━━━━━━━━━━━━━━
${selectedFormats.map((f, i) => `Tweet ${i + 1}: ${f}`).join('\n')}

━━━━━━━━━━━━━━━━━━━━━━
TONE VARIETY:
━━━━━━━━━━━━━━━━━━━━━━
${selectedTones.map((t, i) => `Tweet ${i + 1}: ${t}`).join('\n')}

━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT (CRITICAL — follow exactly):
━━━━━━━━━━━━━━━━━━━━━━
Return ONLY the tweets. No explanations, no labels, no commentary.
Separate each tweet with exactly this delimiter on its own line:
---TWEET---

Example output structure:
[Tweet 1 text here]
---IMAGE_PROMPT---
[Optional: A short prompt to generate an AI image for this tweet (e.g. "A futuristic neon city"). Leave this out completely if the tweet doesn't need an image.]
---TWEET---
[Tweet 2 text here]
---TWEET---
[Tweet 3 text here]

Also, after the last tweet, add one final section:
---TOPICS---
[comma-separated list of the core topics/angles covered in your tweets above, so duplicates can be avoided next time]

Generate exactly ${count} tweets now:`;
}

/**
 * Parse Gemini's raw text response into an array of tweet strings + topics.
 *
 * @param {string} rawText
 * @returns {{ tweets: string[], topics: string[] }}
 */
function parseResponse(rawText) {
  const topicsMatch = rawText.match(/---TOPICS---\s*([\s\S]+)$/);
  const topics = topicsMatch
    ? topicsMatch[1].trim().split(',').map(t => t.trim()).filter(Boolean)
    : [];

  const withoutTopics = topicsMatch
    ? rawText.slice(0, rawText.indexOf('---TOPICS---'))
    : rawText;

  const tweetsRaw = withoutTopics
    .split('---TWEET---')
    .map(t => t.trim())
    .filter(t => t.length > 0);

  const tweets = tweetsRaw.map(t => {
    if (t.includes('---IMAGE_PROMPT---')) {
      const parts = t.split('---IMAGE_PROMPT---');
      return {
        text: parts[0].trim(),
        imagePrompt: parts[1].trim()
      };
    }
    return { text: t };
  });

  return { tweets, topics };
}

module.exports = { buildPrompt, parseResponse, pickRandom };
