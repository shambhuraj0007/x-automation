/**
 * public/app.js
 * Client-side logic for the Post Scheduler dashboard.
 *
 * Handles:
 *  - Smart post splitting (numbered, --- separated, double-newline)
 *  - Dynamic card rendering with edit-in-place
 *  - Pre-calculated posting times shown on each card
 *  - Character counting per post
 *  - Scheduling via backend API with live progress
 */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────
let posts = [];           // Array of { id, text, status, scheduledAt, error? }
let isScheduling = false;
let lastBufferScheduledAt = null; // ISO string of furthest scheduled post in Buffer
let userManuallySetStartTime = false;

// ── DOM Elements ──────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const pasteTextarea   = $('#paste-textarea');
const pasteCharCount  = $('#paste-char-count');
const btnClear        = $('#btn-clear');
const btnSplit        = $('#btn-split');
const pasteSection    = $('#paste-section');

const controlsBar     = $('#controls-bar');
const inputMinSpacing = $('#input-min-spacing');
const inputMaxSpacing = $('#input-max-spacing');
const inputStartTime  = $('#input-start-time');
const postCountBadge  = $('#post-count-badge');
const btnBack         = $('#btn-back');
const btnClearAll     = $('#btn-clear-all');
const btnSchedule     = $('#btn-schedule');

const progressWrapper = $('#progress-wrapper');
const progressBar     = $('#progress-bar');
const postsGrid       = $('#posts-grid');
const emptyState      = $('#empty-state');
const queueCount      = $('#queue-count');
const toastContainer  = $('#toast-container');

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Initial fallback start time
  const now = new Date();
  now.setMinutes(now.getMinutes() + 60);
  inputStartTime.value = toLocalDateTimeString(skipBlackout(now));

  // Query Buffer queue and last scheduled post time
  fetchQueueCount();

  // Event listeners
  pasteTextarea.addEventListener('input', updatePasteCharCount);
  btnClear.addEventListener('click', clearTextarea);
  btnSplit.addEventListener('click', splitPosts);
  btnBack.addEventListener('click', goBack);
  btnClearAll.addEventListener('click', clearAllPosts);
  btnSchedule.addEventListener('click', scheduleAll);

  // Recalculate times when spacing or start time changes
  inputMinSpacing.addEventListener('input', () => {
    inputMinSpacing.dataset.userEdited = 'true';
    recalculateTimes();
  });
  inputMaxSpacing.addEventListener('input', () => {
    inputMaxSpacing.dataset.userEdited = 'true';
    recalculateTimes();
  });
  inputStartTime.addEventListener('input', () => {
    userManuallySetStartTime = true;
    recalculateTimes();
  });
  inputStartTime.addEventListener('change', () => {
    userManuallySetStartTime = true;
    recalculateTimes();
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────

function toLocalDateTimeString(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function generateId() {
  return 'p_' + Math.random().toString(36).slice(2, 10);
}

function randomMinutes(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatDateTime(date) {
  const options = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  };
  return date.toLocaleDateString('en-US', options);
}

function formatTimeOnly(date) {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function formatDateShort(date) {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function updatePasteCharCount() {
  const len = pasteTextarea.value.length;
  pasteCharCount.textContent = `${len.toLocaleString()} characters`;
}

function clearTextarea() {
  pasteTextarea.value = '';
  updatePasteCharCount();
  pasteTextarea.focus();
}

// ── Blackout: Skip 2 AM – 6 AM ───────────────────────────────────────────

const BLACKOUT_START = 2; // 2:00 AM
const BLACKOUT_END = 6;   // 6:00 AM
const BUFFER_MAX_QUEUE = 10;

/**
 * If a date falls within 2 AM – 6 AM, push it forward to 6 AM.
 */
function skipBlackout(date) {
  const d = new Date(date.getTime());
  const hour = d.getHours();
  if (hour >= BLACKOUT_START && hour < BLACKOUT_END) {
    d.setHours(BLACKOUT_END, 0, 0, 0);
  }
  return d;
}

// ── Time Calculation ──────────────────────────────────────────────────────

/**
 * Update the default start time:
 * If Buffer has posts in queue, start AFTER the furthest/last scheduled post in queue + minSpacing.
 * Otherwise start from now + minSpacing.
 * Skips the 2 AM - 6 AM blackout window.
 */
function updateStartTimeDefault() {
  if (userManuallySetStartTime) return;

  const minSpacing = parseInt(inputMinSpacing.value) || 60;
  let baseDate;

  if (lastBufferScheduledAt && new Date(lastBufferScheduledAt) > new Date()) {
    const lastDate = new Date(lastBufferScheduledAt);
    baseDate = new Date(lastDate.getTime() + (minSpacing * 60 * 1000));
    baseDate = skipBlackout(baseDate);

    const label = $('#label-start-time');
    if (label) {
      label.title = `Buffer has posts queued until ${formatDateTime(lastDate)}. New posts start after it.`;
      const currentInQueue = queueCount.textContent.split('/')[0] || '';
      label.innerHTML = `Start After <span style="font-size:0.68rem;color:#38bdf8;font-weight:500;">(after #${currentInQueue} in queue)</span>`;
    }
  } else {
    const now = new Date();
    baseDate = new Date(now.getTime() + (minSpacing * 60 * 1000));
    baseDate = skipBlackout(baseDate);

    const label = $('#label-start-time');
    if (label) {
      label.innerHTML = `Start After`;
    }
  }

  inputStartTime.value = toLocalDateTimeString(baseDate);
}

/**
 * Calculate posting times for all posts based on spacing and start time.
 * Uses random spacing between min and max (default 60–90 min). Skips 2 AM – 6 AM blackout window.
 * The times are stored on each post object so they can be sent to the backend.
 */
function calculatePostingTimes() {
  const minSpacing = parseInt(inputMinSpacing.value) || 60;
  const maxSpacing = parseInt(inputMaxSpacing.value) || 90;

  if (!inputStartTime.value) {
    updateStartTimeDefault();
  }

  const startTime = inputStartTime.value ? new Date(inputStartTime.value) : new Date();
  let baseTime = skipBlackout(new Date(startTime.getTime()));

  posts.forEach((post, i) => {
    if (i === 0) {
      post.scheduledAt = new Date(baseTime.getTime());
    } else {
      const offset = randomMinutes(minSpacing, maxSpacing) * 60 * 1000;
      baseTime = skipBlackout(new Date(baseTime.getTime() + offset));
      post.scheduledAt = new Date(baseTime.getTime());
    }
  });
}

/**
 * Recalculate all times and update the UI (called when spacing/start changes).
 */
function recalculateTimes() {
  if (posts.length === 0) return;
  // Only recalculate for pending posts
  const hasPending = posts.some(p => p.status === 'pending');
  if (!hasPending) return;

  calculatePostingTimes();
  renderPosts();
}

// ── Post Splitting ────────────────────────────────────────────────────────

/**
 * Smart splitter that handles multiple formats:
 *  1. **N.** numbered with --- separators (the format from the user's example)
 *  2. N. simple numbered
 *  3. --- separators only
 *  4. Double-newline separated
 */
function splitPosts() {
  const raw = pasteTextarea.value.trim();
  if (!raw) {
    showToast('Nothing to split — paste your posts first.', 'error');
    return;
  }

  let splitTexts = [];

  // Strategy 1: Try **N.** numbered posts with --- separators
  const numberedPattern = /\*\*\d+\.\*\*/;
  if (numberedPattern.test(raw)) {
    splitTexts = raw
      .split(/\*\*\d+\.\*\*/)
      .map(s => s.replace(/^[\s\-]*/, '').replace(/[\s\-]*$/, '').trim())
      .filter(s => s.length > 0);
  }

  // Strategy 2: Try --- separator (if Strategy 1 didn't find enough)
  if (splitTexts.length <= 1) {
    const bySeparator = raw.split(/\n\s*---\s*\n/);
    if (bySeparator.length > 1) {
      splitTexts = bySeparator
        .map(s => s.replace(/^\*\*\d+\.\*\*\s*\n?/, '').trim())
        .filter(s => s.length > 0);
    }
  }

  // Strategy 3: Try simple N. numbering at line start
  if (splitTexts.length <= 1) {
    const simpleNumbered = raw.split(/\n(?=\d+\.\s)/);
    if (simpleNumbered.length > 1) {
      splitTexts = simpleNumbered
        .map(s => s.replace(/^\d+\.\s*/, '').trim())
        .filter(s => s.length > 0);
    }
  }

  // Strategy 4: Double-newline separation
  if (splitTexts.length <= 1) {
    const byDoubleNewline = raw.split(/\n\s*\n\s*\n/);
    if (byDoubleNewline.length > 1) {
      splitTexts = byDoubleNewline.map(s => s.trim()).filter(s => s.length > 0);
    }
  }

  // Fallback: Treat the whole thing as one post
  if (splitTexts.length === 0) {
    splitTexts = [raw];
  }

  // Clean up any remaining --- separators or leading/trailing whitespace
  splitTexts = splitTexts.map(text => {
    return text
      .replace(/^---\s*\n?/, '')
      .replace(/\n?---\s*$/, '')
      .trim();
  }).filter(s => s.length > 0);

  // Create post objects
  posts = splitTexts.map((text) => ({
    id: generateId(),
    text,
    status: 'pending',
    scheduledAt: null,
  }));

  // Update start time based on last post in Buffer before calculating
  updateStartTimeDefault();
  calculatePostingTimes();

  showToast(`✂️ Split into ${posts.length} posts`, 'success');

  if (lastBufferScheduledAt && new Date(lastBufferScheduledAt) > new Date()) {
    const lastDate = new Date(lastBufferScheduledAt);
    setTimeout(() => {
      showToast(`🕐 Buffer has posts until ${formatTimeOnly(lastDate)}. First new post starts at ${formatTimeOnly(posts[0].scheduledAt)}.`, 'info');
    }, 600);
  }

  showPostsView();
}

// ── View Management ───────────────────────────────────────────────────────

function showPostsView() {
  pasteSection.classList.add('hidden');
  controlsBar.classList.remove('hidden');
  postsGrid.classList.remove('hidden');
  emptyState.classList.add('hidden');

  updatePostCountBadge();
  renderPosts();
}

function goBack() {
  if (isScheduling) {
    showToast('Cannot go back while scheduling is in progress.', 'error');
    return;
  }
  pasteSection.classList.remove('hidden');
  controlsBar.classList.add('hidden');
  postsGrid.classList.add('hidden');
  progressWrapper.classList.add('hidden');
  emptyState.classList.add('hidden');
}

function clearAllPosts() {
  if (isScheduling) return;
  posts = [];
  renderPosts();
  updatePostCountBadge();
  goBack();
  showToast('All posts cleared.', 'info');
}

function updatePostCountBadge() {
  const totalDuration = getTotalScheduleDuration();
  postCountBadge.textContent = `${posts.length} post${posts.length !== 1 ? 's' : ''} · ${totalDuration}`;
}

function getTotalScheduleDuration() {
  if (posts.length < 2) return '—';
  const first = posts[0].scheduledAt;
  const last = posts[posts.length - 1].scheduledAt;
  if (!first || !last) return '—';

  const diffMs = last.getTime() - first.getTime();
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const mins = Math.round((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  if (hours === 0) return `~${mins}m span`;
  return `~${hours}h ${mins}m span`;
}

// ── Rendering ─────────────────────────────────────────────────────────────

function renderPosts() {
  postsGrid.innerHTML = '';

  if (posts.length === 0) {
    emptyState.classList.remove('hidden');
    postsGrid.classList.add('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  postsGrid.classList.remove('hidden');

  posts.forEach((post, index) => {
    const card = createPostCard(post, index);
    postsGrid.appendChild(card);
  });
}

function createPostCard(post, index) {
  const card = document.createElement('div');
  card.className = `post-card ${getCardStatusClass(post.status)}`;
  card.id = `card-${post.id}`;
  card.style.animationDelay = `${index * 0.04}s`;

  const charCount = post.text.length;
  const charClass = charCount > 280 ? 'post-card__char-count--danger' :
                    charCount > 250 ? 'post-card__char-count--warning' : '';

  // Format the scheduled time
  const timeDisplay = post.scheduledAt ? formatDateTime(post.scheduledAt) : '—';
  const timeShort = post.scheduledAt ? formatTimeOnly(post.scheduledAt) : '';
  const dateShort = post.scheduledAt ? formatDateShort(post.scheduledAt) : '';

  // Relative time from now
  const relativeTime = post.scheduledAt ? getRelativeTime(post.scheduledAt) : '';

  card.innerHTML = `
    <div class="post-card__header">
      <div class="post-card__header-left">
        <div class="post-card__number">${index + 1}</div>
        <div class="post-card__time-badge" title="${timeDisplay}">
          <span class="post-card__time-icon">🕐</span>
          <span class="post-card__time-text">${timeShort}</span>
          <span class="post-card__time-date">${dateShort}</span>
        </div>
      </div>
      <div class="post-card__actions">
        <button class="post-card__action-btn post-card__action-btn--delete"
                onclick="deletePost('${post.id}')"
                title="Delete this post"
                ${post.status !== 'pending' ? 'disabled' : ''}>
          ✕
        </button>
      </div>
    </div>
    ${relativeTime ? `<div class="post-card__relative-time">${relativeTime}</div>` : ''}
    <div class="post-card__body">
      <textarea class="post-card__text"
                id="text-${post.id}"
                onInput="onPostEdit('${post.id}', this)"
                ${post.status !== 'pending' ? 'readonly' : ''}
      >${escapeHtml(post.text)}</textarea>
    </div>
    <div class="post-card__footer">
      <span class="post-card__char-count ${charClass}" id="chars-${post.id}">
        ${charCount}/280
      </span>
      <span class="post-card__status post-card__status--${post.status}" id="status-${post.id}">
        ${getStatusContent(post)}
      </span>
    </div>
  `;

  return card;
}

function getRelativeTime(date) {
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  if (diffMs < 0) return 'in the past';

  const mins = Math.round(diffMs / (1000 * 60));
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return `in ${hours}h ${remMins}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `in ${days}d ${remHours}h`;
}

function getCardStatusClass(status) {
  switch (status) {
    case 'scheduling': return 'post-card--scheduling';
    case 'scheduled':  return 'post-card--scheduled';
    case 'queued':     return 'post-card--queued';
    case 'error':      return 'post-card--error';
    default:           return '';
  }
}

function getStatusContent(post) {
  switch (post.status) {
    case 'pending':
      return '⏳ Pending';
    case 'scheduling':
      return '<span class="status-spinner"></span> Scheduling...';
    case 'scheduled':
      return '✅ In Buffer';
    case 'queued':
      return '🕐 Queued (auto-fill)';
    case 'error':
      return `❌ ${post.error || 'Failed'}`;
    default:
      return '';
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ── Post Editing ──────────────────────────────────────────────────────────

function onPostEdit(postId, textarea) {
  const post = posts.find(p => p.id === postId);
  if (!post || post.status !== 'pending') return;

  post.text = textarea.value;
  const charCount = post.text.length;

  const charEl = document.getElementById(`chars-${postId}`);
  if (charEl) {
    charEl.textContent = `${charCount}/280`;
    charEl.className = 'post-card__char-count' + (
      charCount > 280 ? ' post-card__char-count--danger' :
      charCount > 250 ? ' post-card__char-count--warning' : ''
    );
  }
}

function deletePost(postId) {
  if (isScheduling) return;
  posts = posts.filter(p => p.id !== postId);

  // Recalculate times after deletion
  calculatePostingTimes();
  updatePostCountBadge();
  renderPosts();

  if (posts.length === 0) {
    goBack();
  }
}

// Make functions available globally for inline event handlers
window.deletePost = deletePost;
window.onPostEdit = onPostEdit;

// ── Scheduling ────────────────────────────────────────────────────────────

async function scheduleAll() {
  if (isScheduling) return;

  const pendingPosts = posts.filter(p => p.status === 'pending');
  if (pendingPosts.length === 0) {
    showToast('No pending posts to schedule.', 'error');
    return;
  }

  // Validate spacing
  const minSpacing = parseInt(inputMinSpacing.value) || 45;
  const maxSpacing = parseInt(inputMaxSpacing.value) || 80;
  if (minSpacing > maxSpacing) {
    showToast('Min spacing cannot be greater than max spacing.', 'error');
    return;
  }

  // Check for over-280 posts
  const overLimit = pendingPosts.filter(p => p.text.length > 280);
  if (overLimit.length > 0) {
    showToast(`⚠️ ${overLimit.length} post(s) exceed 280 characters. They'll still be sent but may be truncated by Twitter.`, 'info');
  }

  isScheduling = true;
  btnSchedule.disabled = true;
  btnBack.disabled = true;
  btnClearAll.disabled = true;
  progressWrapper.classList.remove('hidden');

  // Build posts with their pre-calculated times
  const postsToSchedule = pendingPosts.map(p => ({
    text: p.text,
    scheduledAt: p.scheduledAt.toISOString(),
  }));

  // Mark all as scheduling
  pendingPosts.forEach(p => {
    p.status = 'scheduling';
    updateCardStatus(p);
  });

  try {
    const response = await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ posts: postsToSchedule }),
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Scheduling failed');
    }

    // Update each post status based on result
    const results = result.results || [];
    pendingPosts.forEach((post, i) => {
      const r = results[i];
      if (r && r.status === 'scheduled') {
        post.status = 'scheduled';
        post.scheduledAt = new Date(r.scheduledAt);
      } else if (r && r.status === 'queued') {
        post.status = 'queued';
        post.scheduledAt = new Date(r.scheduledAt);
      } else {
        post.status = 'error';
        post.error = r ? r.error : 'Unknown error';
      }
      updateCardStatus(post);
      // Animate progress
      const pct = Math.round(((i + 1) / pendingPosts.length) * 100);
      progressBar.style.width = `${pct}%`;
    });

    const scheduled = result.scheduledNow || 0;
    const queued = result.queuedForLater || 0;
    const failed = result.failed || 0;

    if (failed === 0 && queued === 0) {
      showToast(`🚀 All ${scheduled} posts sent to Buffer!`, 'success');
    } else if (failed === 0) {
      showToast(`✅ ${scheduled} sent to Buffer now, ${queued} queued for auto-fill (every 4h)`, 'success');
    } else {
      showToast(`⚠️ ${scheduled} sent, ${queued} queued, ${failed} failed.`, 'error');
    }

    // Refresh queue count
    fetchQueueCount();

  } catch (err) {
    pendingPosts.forEach(p => {
      if (p.status === 'scheduling') {
        p.status = 'error';
        p.error = err.message;
        updateCardStatus(p);
      }
    });
    showToast(`❌ ${err.message}`, 'error');
  } finally {
    isScheduling = false;
    btnSchedule.disabled = false;
    btnBack.disabled = false;
    btnClearAll.disabled = false;
  }
}

function updateCardStatus(post) {
  const card = document.getElementById(`card-${post.id}`);
  if (!card) return;

  // Update class
  card.className = `post-card ${getCardStatusClass(post.status)}`;

  // Update status text
  const statusEl = document.getElementById(`status-${post.id}`);
  if (statusEl) {
    statusEl.className = `post-card__status post-card__status--${post.status}`;
    statusEl.innerHTML = getStatusContent(post);
  }

  // Make textarea readonly if not pending
  const textEl = document.getElementById(`text-${post.id}`);
  if (textEl && post.status !== 'pending') {
    textEl.readOnly = true;
  }
}

// ── Queue Count ───────────────────────────────────────────────────────────

async function fetchQueueCount() {
  try {
    const res = await fetch('/api/queue');
    const data = await res.json();
    const bufferCount = data.count ?? '—';
    const pending = data.localQueue?.pending || 0;
    lastBufferScheduledAt = data.lastScheduledAt || null;

    if (data.minSpacing && !inputMinSpacing.dataset.userEdited) {
      inputMinSpacing.value = data.minSpacing;
    }
    if (data.maxSpacing && !inputMaxSpacing.dataset.userEdited) {
      inputMaxSpacing.value = data.maxSpacing;
    }

    queueCount.textContent = `${bufferCount}/10`;
    if (pending > 0) {
      queueCount.textContent += ` · ${pending} queued`;
    }

    updateStartTimeDefault();
    if (posts.length > 0 && !userManuallySetStartTime) {
      recalculateTimes();
    }
  } catch {
    queueCount.textContent = '—';
  }
}

// ── Toasts ────────────────────────────────────────────────────────────────

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.innerHTML = `<span>${message}</span>`;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast--exit');
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}
