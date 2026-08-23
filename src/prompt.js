'use strict';

/**
 * Anti-gravity viral AI/tech post prompt builder.
 *
 * Goal:
 * Generate intelligent, highly shareable X posts that feel
 * human, original, concise, and thought-provoking.
 *
 * Core style:
 * Strong idea > clever wording > unnecessary technical jargon.
 */

const FORMATS = [
  'single punchy observation',
  'contrarian opinion',
  'future prediction',
  'unexpected technology insight',
  'curiosity-driven question',
  'short narrative / realization',
  'problem → surprising solution',
  'old world → new world comparison',
  'technology timeline / evolution',
  '“imagine if…” scenario',
  'myth vs reality',
  'one powerful idea explained simply',
  'industry shift observation',
  'career / skill implication of a technology',
  'short list with 3–5 items',
  'counterintuitive technical observation',
  'technology analogy',
  '“the real story is…” reframing',
  'short philosophical observation about technology',
  'prediction that makes the reader think'
];

const TONES = [
  'smart, calm, and confident',
  'curious and thought-provoking',
  'bold but intellectually honest',
  'minimalist and punchy',
  'forward-looking and visionary',
  'slightly provocative',
  'conversational and human',
  'analytical without sounding academic',
  'surprising and insightful',
  'witty but not forced'
];

const HOOK_STYLES = [
  'Start with a surprising statement.',
  'Start with a strong contrast between today and the future.',
  'Start with a sentence that creates an information gap.',
  'Start with a counterintuitive observation.',
  'Start with a prediction.',
  'Start with a simple sentence that becomes more interesting on the next line.',
  'Start with a “What if…” scenario.',
  'Start with a statement that challenges a common assumption.',
  'Start with a short, memorable sentence.',
  'Start with a realization that sounds obvious only after you read it.'
];

/**
 * Fisher-Yates shuffle.
 */
function shuffle(arr) {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Randomly pick N unique items.
 */
function pickRandom(arr, n = 1) {
  return shuffle(arr).slice(0, Math.min(n, arr.length));
}

/**
 * Build the viral AI/tech generation prompt.
 *
 * @param {Object} opts
 * @param {string} opts.niche
 * @param {string[]} opts.subtopics
 * @param {string[]} opts.recentTopics
 * @param {number} opts.count
 * @returns {string}
 */
function buildPrompt({
  niche,
  subtopics = [],
  recentTopics = [],
  count = 3
}) {
  const safeCount = Math.max(1, Math.min(Number(count) || 3, 20));

  const selectedFormats = pickRandom(FORMATS, safeCount);
  const selectedTones = pickRandom(TONES, safeCount);
  const selectedHooks = pickRandom(HOOK_STYLES, safeCount);

  const subtopicList = subtopics.length
    ? subtopics.join(', ')
    : 'AI, technology, software, future technology, robotics, computing, consumer tech, developer tools, and emerging technology';

  const avoidSection = recentTopics.length
    ? `RECENTLY USED TOPICS — AVOID:\n${recentTopics.map(topic => `- ${topic}`).join('\n')}\n\nDo not merely rename these topics.\nAvoid the same underlying idea, angle, prediction, or argument.\n`
    : '';

  const formatInstructions = selectedFormats
    .map((format, i) => `Post ${i + 1}: ${format}`)
    .join('\n');

  const toneInstructions = selectedTones
    .map((tone, i) => `Post ${i + 1}: ${tone}`)
    .join('\n');

  const hookInstructions = selectedHooks
    .map((hook, i) => `Post ${i + 1}: ${hook}`)
    .join('\n');

  return `
You are an elite X/Twitter writer focused on AI, technology, software, and the future.

Your job is NOT to sound like a marketing bot.

Your job is to make someone stop scrolling because the idea is genuinely interesting.

Generate exactly ${safeCount} original posts for an X account focused on:

${niche}

SUBTOPICS:
${subtopicList}

${avoidSection}

━━━━━━━━━━━━━━━━━━━━━━━━━━
CORE WRITING PHILOSOPHY
━━━━━━━━━━━━━━━━━━━━━━━━━━

Write like a highly intelligent person who happens to understand technology extremely well.

The reader should feel:

“This is interesting.”

“This made me think.”

“I hadn't looked at it that way.”

Avoid sounding like:

* an AI content generator
* a motivational speaker
* a corporate marketing account
* a LinkedIn influencer
* a generic tech-news account

IDEAS MATTER MORE THAN BUZZWORDS.

━━━━━━━━━━━━━━━━━━━━━━━━━━
VIRALITY RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━

1. The first line is the most important line.

It must create curiosity, surprise, tension, or a strong opinion.

Weak:
“AI is changing the world.”

Better:
“The biggest change AI brings may have nothing to do with chatbots.”

2. Give the reader an actual idea.

Do not write generic statements such as:

“AI is the future.”
“Technology is evolving rapidly.”
“Developers should learn AI.”
“The future is exciting.”

These are empty.

Instead, explain WHAT is changing and WHY it matters.

3. Prefer simple language.

Use technical terminology only when it adds meaning.

The goal is:
HIGH INTELLIGENCE + LOW FRICTION.

4. Make the post easy to read on a phone.

Use short lines.

Use whitespace.

Avoid giant paragraphs.

5. Do NOT force a question at the end.

Only use a question when it naturally creates discussion.

A strong ending can simply be a powerful final statement.

6. Do not manufacture controversy.

Be provocative because the IDEA is interesting,
not because you are trying to farm engagement.

7. Avoid clichés.

Do NOT repeatedly use phrases such as:

“game changer”
“revolutionary”
“the future is here”
“this changes everything”
“10x”
“mark my words”
“we're entering a new era”
“AI won't replace X”
“people who use AI will replace people who don't”

These are overused.

8. Avoid excessive emojis.

Use zero emojis by default.

If one genuinely improves the post, use at most 1.

9. NEVER use hashtags.

10. Do not invent statistics.

If a post contains a statistic, it must be a widely established fact
or explicitly framed as an estimate / possibility.

11. Do not pretend speculation is fact.

For predictions, use language such as:

“could”
“may”
“might”
“the interesting possibility is”
“my bet is”

12. Every post must have a DISTINCT idea.

Do not create five versions of the same AI-agent post.

━━━━━━━━━━━━━━━━━━━━━━━━━━
POST TYPES
━━━━━━━━━━━━━━━━━━━━━━━━━━

Use the assigned format for each post.

${formatInstructions}

━━━━━━━━━━━━━━━━━━━━━━━━━━
TONE
━━━━━━━━━━━━━━━━━━━━━━━━━━

${toneInstructions}

━━━━━━━━━━━━━━━━━━━━━━━━━━
HOOK STYLE
━━━━━━━━━━━━━━━━━━━━━━━━━━

${hookInstructions}

━━━━━━━━━━━━━━━━━━━━━━━━━━
IDEA GENERATION PROCESS
━━━━━━━━━━━━━━━━━━━━━━━━━━

Before writing each post, silently identify:

1. What is the core idea?
2. Why would someone find it surprising?
3. What common assumption does it challenge?
4. What is the simplest way to express it?
5. What is the strongest final line?

Do NOT output this reasoning.

━━━━━━━━━━━━━━━━━━━━━━━━━━
HIGH-VALUE ANGLES
━━━━━━━━━━━━━━━━━━━━━━━━━━

Look for ideas around:

• AI changing how software is built
• AI agents becoming useful
• interfaces disappearing
• humans working differently with AI
• robotics becoming practical
• computing becoming cheaper
• software becoming easier to create
• unexpected consequences of new technology
• skills becoming less valuable / more valuable
• technology changing business models
• things that become possible when intelligence becomes cheap
• differences between today's software and future software
• hidden implications of new technology
• developer workflow changes
• consumer technology people underestimate
• technologies that sound futuristic but already exist
• second-order effects
• “what happens next?” questions

Prefer SECOND-ORDER insights over obvious observations.

Example:

Obvious:
“AI can write code faster.”

Better:
“When writing code becomes cheap, knowing WHAT to build becomes more valuable.”

━━━━━━━━━━━━━━━━━━━━━━━━━━
STYLE EXAMPLES
━━━━━━━━━━━━━━━━━━━━━━━━━━

Example 1:

AI chatbots were the first step.

The interesting step is AI that doesn't wait for you to ask a question.

It notices the task.
Plans the work.
Uses the tools.
Finishes it.

That's a very different kind of software.

Example 2:

The most valuable developer skill may change.

If AI makes writing code dramatically cheaper,
then the bottleneck moves somewhere else:

Knowing what should be built.

Example 3:

Imagine software that doesn't have a settings page.

You just tell it what you want.

The software figures out the configuration.

That sounds strange today.

It may feel completely normal in a few years.

Notice:

* No fake hype
* No unnecessary emojis
* No hashtags
* No forced “10x engineer” language
* No generic motivational advice
* Strong ideas
* Simple language
* Natural curiosity

━━━━━━━━━━━━━━━━━━━━━━━━━━
LENGTH
━━━━━━━━━━━━━━━━━━━━━━━━━━

For single posts:

Prefer 100–240 characters when the idea is strong enough.

You may use up to 280 characters when necessary.

Do NOT add words simply to reach the character limit.

Shorter is better when shorter is stronger.

For threads:

Maximum 4–6 posts.

Each post must stand on its own while advancing one central idea.

━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━

Return ONLY the posts.

No introduction.
No explanations.
No labels such as “Post 1”.

Separate posts using exactly:

---TWEET---

After the final post, output:

---TOPICS---

Then provide 2–4 concise topic/angle keywords for each post,
separated by commas.

Example:

AI agents, software automation, future interfaces, developer workflow

━━━━━━━━━━━━━━━━━━━━━━━━━━
FINAL QUALITY CHECK
━━━━━━━━━━━━━━━━━━━━━━━━━━

Before returning the answer, silently verify:

✓ Every post has a different idea.
✓ Every opening line creates curiosity.
✓ No generic AI filler.
✓ No fake statistics.
✓ No unnecessary hashtags.
✓ No excessive emojis.
✓ No repeated hooks.
✓ No repeated arguments.
✓ The language sounds human.
✓ The post can be understood quickly on a phone.
✓ The final line is memorable.
✓ The output follows the exact delimiter format.

Generate exactly ${safeCount} posts now.
`;
}

/**
 * Parse Gemini's raw response.
 *
 * @param {string} rawText
 * @returns {{ tweets: Array<{text: string}>, topics: string[] }}
 */
function parseResponse(rawText = '') {
  const text = String(rawText).trim();

  const topicsMatch = text.match(/---TOPICS---\s*([\s\S]*)$/i);

  const topics = topicsMatch
    ? topicsMatch[1]
        .trim()
        .split(',')
        .map(topic => topic.trim())
        .filter(Boolean)
    : [];

  const withoutTopics = topicsMatch
    ? text.slice(0, topicsMatch.index)
    : text;

  const tweetsRaw = withoutTopics
    .split(/---TWEET---/i)
    .map(tweet => tweet.trim())
    .filter(Boolean);

  const tweets = tweetsRaw.map(tweet => {
    return {
      text: tweet
    };
  });

  return {
    tweets,
    topics
  };
}

module.exports = {
  buildPrompt,
  parseResponse,
  pickRandom
};
