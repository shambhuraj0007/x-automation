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
  'A short, punchy single tweet (max 280 chars) with a controversial or surprising technical opinion.',
  'A technical contrarian hot take that challenges common engineering wisdom or best practices.',
  'A 3-part micro-thread breaking down a complex architecture, algorithm, or technical concept into simple terms.',
  'An actionable coding or system design "how-to" formatted as a bulleted list.',
  'A story-driven tweet starting with a painful debugging session or production failure, ending with a technical lesson.',
  'A direct, highly technical prediction about the next 5 years of frameworks, tools, or AI in this niche.',
  'An observation about a hidden engineering anti-pattern nobody is talking about.'
];

const TONES = [
  'highly technical and authoritative',
  'casual, witty, and slightly sarcastic (like a tired senior engineer)',
  'urgent and mind-blowing (revealing a powerful technical paradigm)',
  'analytical, architectural, and reflective',
  'inspiring and forward-looking for developers',
  'data-driven, precise, and punchy',
];

/**
 * Randomly pick N items from an array.
 */
function pickRandom(arr, n = 1) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n); // Always return an array, even for n=1
}

/**
 * Build the anti-gravity viral tweet generation prompt.
 *
 * @param {Object} opts
 * @param {string}   opts.niche         - Main topic niche
 * @param {string[]} opts.subtopics     - Subtopics to draw from
 * @param {string[]} opts.recentTopics  - Recently used topics to avoid
 * @param {number}   opts.count         - Number of posts to generate
 * @returns {string} The full prompt for the Gemini API
 */
function buildPrompt({ niche, subtopics, recentTopics, count = 3 }) {
  const selectedFormats = pickRandom(FORMATS, Math.min(count, FORMATS.length));
  const selectedTones = pickRandom(TONES, Math.min(count, TONES.length));

  const subtopicList = subtopics.length > 0
    ? subtopics.join(', ')
    : 'Anything highly relevant, technical, and cutting-edge in this niche.';

  const avoidSection = recentTopics.length > 0
    ? `\nCRITICAL: Do NOT write about these recently covered topics:\n- ${recentTopics.join('\n- ')}\n`
    : '';

  return `You are an elite, highly technical viral Twitter ghostwriter and Senior Staff Engineer with a track record of writing technical tweets that get 10,000+ likes and go massively viral. You deeply understand what makes developer content spread: technical depth, surprising architectures, strong opinions on tooling, and raw truth about software engineering.

Your task: Generate exactly ${count} original, high-quality technical tweets for a Twitter account focused on **${niche}**.

Subtopics to draw inspiration from: ${subtopicList}
${avoidSection}

━━━━━━━━━━━━━━━━━━━━━━
STRICT RULES (follow every single one):
━━━━━━━━━━━━━━━━━━━━━━
1. Each tweet must feel DIFFERENT in angle, format, and tone.
2. Open every tweet with an irresistible hook — the first line must make developers STOP scrolling.
3. Never use generic advice. Be highly specific, technical, counterintuitive, or surprising. Use real technical terminology.
4. FORMATTING IS KING: Use line breaks strategically. Keep paragraphs to 1-2 sentences. Make code/logic explanations incredibly easy to read on a phone screen.
5. EMOJIS: Use emojis tastefully to draw attention to key points, lists, or hooks (e.g. 🚀, 💡, 🧠, ⚠️, 🛠️, 💻). NO hashtags.
6. DRIVE ENGAGEMENT: End at least half of your tweets with a polarizing technical question, a call for engineering opinions, or a prompt that practically forces devs to reply in the comments.
7. Threads must have a strong "1/" opener. End threads with a question to drive replies.
8. Think like an elite 10x engineer and the top 1% of technical content creators on X. Be bold, authoritative, polarizing, and relatable to developers.
9. Make readers feel something: curiosity, surprise, urgency, inspiration, or a mild technical provocation.
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

EVERY tweet MUST include an ---IMAGE_PROMPT--- section. This is NOT optional.
The image prompt should be a vivid, visual description (10–25 words) that pairs perfectly with the tweet — think cinematic, bold, photorealistic or stylised illustration.

Example output structure:
[Tweet 1 text here]
---IMAGE_PROMPT---
[A vivid visual description for the AI image — e.g. "A lone developer surrounded by glowing holographic code at 3am, cyberpunk aesthetic, dramatic lighting"]
---TWEET---
[Tweet 2 text here]
---IMAGE_PROMPT---
[A vivid visual description for the AI image]
---TWEET---
[Tweet 3 text here]
---IMAGE_PROMPT---
[A vivid visual description for the AI image]

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
    // Fallback: model skipped the image prompt — derive one from the tweet text
    const fallbackPrompt = _buildFallbackImagePrompt(t);
    return { text: t, imagePrompt: fallbackPrompt };
  });

  return { tweets, topics };
}

/**
 * Build a simple fallback image prompt from the first line of tweet text
 * so that every post always has an image even when the model disobeys.
 * @private
 * @param {string} tweetText
 * @returns {string}
 */
function _buildFallbackImagePrompt(tweetText) {
  // Use the first sentence / line (max 120 chars) as the image concept
  const firstLine = tweetText.split('\n')[0].replace(/\d+\/\s*/, '').trim();
  const concept = firstLine.length > 120 ? firstLine.slice(0, 120) : firstLine;
  return `Cinematic illustration representing: ${concept}. Dramatic lighting, high detail, bold composition.`;
}

module.exports = { buildPrompt, parseResponse, pickRandom };
