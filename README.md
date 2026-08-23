# 🐦 Twitter Automation — Self-Refilling Buffer Queue

A fully autonomous Node.js daemon that keeps your X/Twitter Buffer queue filled
with AI-generated viral posts — 24/7, with zero manual effort.

## How It Works

```
Every 10 minutes
      ↓
Check Buffer queue count
      ↓
≤ 1 post remaining?  ──YES──→  Generate 3 viral posts via Gemini
      ↓                              ↓
      NO                     Schedule in Buffer
      ↓                       (45–120 min apart)
      Wait                          ↓
                             Queue is full again ✅

Also: 4-hour fallback cron fires if the queue drops ≤ 3 posts
(catches edge cases the real-time monitor might miss)
```

---

## Quick Start

### 1. Install Node.js (v18+)

Download from [nodejs.org](https://nodejs.org) if you don't have it.

### 2. Install dependencies

```bash
cd "TWITTER AUTOMATION"
npm install
```

### 3. Configure your API keys

```bash
copy .env.example .env
```

Then open `.env` and fill in:

| Variable | Where to get it |
|---|---|
| `GEMINI_API_KEY` | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) |
| `BUFFER_ACCESS_TOKEN` | [buffer.com/developers/apps](https://buffer.com/developers/apps) |
| `BUFFER_PROFILE_ID` | See step 4 below |
| `TWEET_NICHE` | Your account's main topic (e.g. "AI and technology") |

### 4. Find your Buffer Profile ID

Run this in your browser or via curl after replacing `YOUR_TOKEN`:

```
GET https://api.bufferapp.com/1/profiles.json?access_token=YOUR_TOKEN
```

Find the `"id"` field under your X/Twitter profile entry and paste it into
`BUFFER_PROFILE_ID` in your `.env`.

### 5. Test in dry-run mode first

This generates posts and prints them to the console **without** touching Buffer:

```bash
# Windows PowerShell
$env:DRY_RUN="true"; node index.js
```

### 6. Run for real

```bash
node index.js
```

You'll see a banner and live logs:

```
═══════════════════════════════════════════
  🐦 Twitter Automation Daemon — Starting Up
  Niche    : AI and technology
  Model    : gemini-1.5-flash
  Batch    : 3 posts per refill
  Spacing  : 45–120 min
  Poll     : every 10 min
  Threshold: refill when ≤ 1 post
  Mode     : 🟢 LIVE
═══════════════════════════════════════════
```

---

## Configuration Reference

All settings live in `.env` — no code changes needed.

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | — | **Required.** Gemini API key |
| `GEMINI_MODEL` | `gemini-1.5-flash` | Model to use |
| `BUFFER_ACCESS_TOKEN` | — | **Required.** Buffer OAuth token |
| `BUFFER_PROFILE_ID` | — | **Required.** Buffer X/Twitter profile ID |
| `TWEET_NICHE` | `AI and technology` | Main topic for tweet generation |
| `TWEET_SUBTOPICS` | — | Comma-separated subtopics |
| `QUEUE_REFILL_THRESHOLD` | `1` | Immediate refill trigger |
| `QUEUE_SOFT_THRESHOLD` | `3` | 4-hour cron refill trigger |
| `POSTS_PER_BATCH` | `3` | Posts generated per refill |
| `MIN_SPACING_MINUTES` | `45` | Min gap between scheduled posts |
| `MAX_SPACING_MINUTES` | `120` | Max gap between scheduled posts |
| `QUEUE_POLL_INTERVAL_MINUTES` | `10` | How often to check queue |
| `DRY_RUN` | `false` | `true` = log only, no real API calls |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |
| `TOPIC_MEMORY_DAYS` | `7` | Days to remember used topics |

---

## Run as a Background Service (Windows)

To keep it running after you close the terminal, use [PM2](https://pm2.keymetrics.io/):

```powershell
npm install -g pm2
pm2 start index.js --name twitter-automation
pm2 save
pm2 startup   # Follow the instructions it prints
```

View logs:
```powershell
pm2 logs twitter-automation
```

---

## Run Tests

```bash
node tests/test.js
```

All tests run offline — no API calls.

---

## File Structure

```
TWITTER AUTOMATION/
├── index.js              ← Main daemon entry point
├── package.json
├── .env.example          ← Copy to .env and fill in keys
├── .gitignore
├── src/
│   ├── logger.js         ← Winston logging (console + rotating files)
│   ├── prompt.js         ← Viral tweet prompt builder + response parser
│   ├── gemini.js         ← Gemini API client (generates posts)
│   ├── buffer.js         ← Buffer API client (schedules posts)
│   ├── scheduler.js      ← Queue monitor + 4-hour cron
│   └── topicRegistry.js  ← Duplicate topic detection (disk-persisted)
├── tests/
│   └── test.js           ← Offline unit tests
├── logs/                 ← Auto-created. Daily rotating log files
└── data/
    └── topics.json       ← Auto-created. Persisted topic memory
```

---

## Troubleshooting

**"Missing environment variables" on startup**
→ Copy `.env.example` to `.env` and fill in all three required keys.

**Buffer API returns 401**
→ Your `BUFFER_ACCESS_TOKEN` is expired or wrong. Regenerate it in Buffer's developer portal.

**Gemini returns empty response**
→ Check your `GEMINI_API_KEY`. Make sure your project has the Generative Language API enabled.

**Posts look repetitive**
→ Increase `TOPIC_MEMORY_DAYS` or add more `TWEET_SUBTOPICS` entries.

**Want higher-quality posts (slower/pricier)**
→ Set `GEMINI_MODEL=gemini-1.5-pro` in your `.env`.
