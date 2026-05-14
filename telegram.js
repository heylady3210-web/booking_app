// Telegram auto-posting module
// Handles Telegram Bot API calls and the Supabase queue for scheduled posts.

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const CHANNEL_ID   = process.env.TELEGRAM_CHANNEL_ID;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://iyvlqirnjwmgcynqgwfh.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // service role — bypasses RLS

// ── Supabase helpers ─────────────────────────────────────────────────────────

function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer': 'return=representation'
  };
}

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`Supabase GET failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function sbPost(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Supabase POST failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function sbPatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: sbHeaders(),
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Supabase PATCH failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function sbDelete(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: sbHeaders()
  });
  if (!res.ok) throw new Error(`Supabase DELETE failed: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// ── Telegram API helpers ─────────────────────────────────────────────────────

const MAX_CAPTION = 1024;
const MAX_MESSAGE = 4096;

function trimCaption(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

async function tgCall(method, body) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description}`);
  return data.result;
}

// ── Public: send a post to the channel ──────────────────────────────────────

async function sendPost(post) {
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN not set');
  if (!CHANNEL_ID) throw new Error('TELEGRAM_CHANNEL_ID not set');

  const { media_type, caption, image_url, video_url } = post;

  if (media_type === 'photo' && image_url) {
    return tgCall('sendPhoto', {
      chat_id: CHANNEL_ID,
      photo: image_url,
      caption: trimCaption(caption, MAX_CAPTION),
      parse_mode: 'HTML'
    });
  }

  if (media_type === 'video' && video_url) {
    return tgCall('sendVideo', {
      chat_id: CHANNEL_ID,
      video: video_url,
      caption: trimCaption(caption, MAX_CAPTION),
      parse_mode: 'HTML'
    });
  }

  // Text-only fallback
  return tgCall('sendMessage', {
    chat_id: CHANNEL_ID,
    text: trimCaption(caption, MAX_MESSAGE),
    parse_mode: 'HTML'
  });
}

// ── Public: bot health check ─────────────────────────────────────────────────

async function getBotInfo() {
  if (!process.env.TELEGRAM_BOT_TOKEN) return { connected: false, error: 'TELEGRAM_BOT_TOKEN not set' };
  try {
    const bot = await tgCall('getMe', {});
    return { connected: true, username: bot.username, name: bot.first_name };
  } catch (e) {
    return { connected: false, error: e.message };
  }
}

// ── Queue helpers ────────────────────────────────────────────────────────────

async function getQueue() {
  return sbGet("telegram_posts?status=not.in.(sent,cancelled)&order=scheduled_at.asc");
}

async function getHistory(limit = 50) {
  return sbGet(`telegram_posts?status=in.(sent,failed,cancelled)&order=sent_at.desc&limit=${limit}`);
}

async function createPost(fields) {
  const [row] = await sbPost('telegram_posts', fields);
  return row;
}

async function updatePost(id, fields) {
  const [row] = await sbPatch(`telegram_posts?id=eq.${id}`, fields);
  return row;
}

async function deletePost(id) {
  return sbDelete(`telegram_posts?id=eq.${id}&status=not.eq.sent`);
}

async function markSent(id, telegramMessageId) {
  return updatePost(id, { status: 'sent', sent_at: new Date().toISOString(), telegram_message_id: telegramMessageId });
}

async function markFailed(id, errorMessage) {
  return updatePost(id, { status: 'failed', sent_at: new Date().toISOString(), error_message: errorMessage });
}

// ── Cron: process the queue every minute ────────────────────────────────────

async function processQueue() {
  if (!SUPABASE_KEY) { console.warn('[Telegram] SUPABASE_SERVICE_KEY not set — queue processing skipped'); return; }
  if (!process.env.TELEGRAM_BOT_TOKEN) { console.warn('[Telegram] TELEGRAM_BOT_TOKEN not set — queue processing skipped'); return; }

  // Blackout hours check (23:00–07:00 local server time)
  const hour = new Date().getHours();
  if (hour >= 23 || hour < 7) return;

  let duePosts;
  try {
    duePosts = await sbGet(
      `telegram_posts?status=eq.queued&scheduled_at=lte.${encodeURIComponent(new Date().toISOString())}&order=scheduled_at.asc`
    );
  } catch (e) {
    console.error('[Telegram] Queue fetch error:', e.message);
    return;
  }

  for (const post of duePosts) {
    try {
      const result = await sendPost(post);
      await markSent(post.id, result.message_id);
      console.log(`[Telegram] Sent post ${post.id} → message_id ${result.message_id}`);
    } catch (e) {
      await markFailed(post.id, e.message);
      console.error(`[Telegram] Failed post ${post.id}:`, e.message);
    }
  }
}

// ── Calendar import helper ───────────────────────────────────────────────────

async function getCalendarPostsForTelegram() {
  // Fetch calendar posts with channel=Telegram and status=Scheduled
  const posts = await sbGet(
    `calendar_posts?channel=eq.Telegram&status=eq.Scheduled&order=date.asc`
  );

  // Get already-imported IDs so we can flag them
  const imported = await sbGet('telegram_posts?source=eq.calendar&select=calendar_post_id');
  const importedIds = new Set(imported.map(r => r.calendar_post_id));

  return posts.map(p => ({ ...p, already_imported: importedIds.has(p.id) }));
}

async function importCalendarPost(calendarPost, scheduledAt) {
  return createPost({
    source: 'calendar',
    calendar_post_id: calendarPost.id,
    caption: calendarPost.caption || calendarPost.title || '',
    image_url: calendarPost.visual?.startsWith('http') ? calendarPost.visual : null,
    media_type: calendarPost.visual?.startsWith('http') ? 'photo' : 'text',
    status: 'queued',
    scheduled_at: scheduledAt
  });
}

module.exports = {
  sendPost,
  getBotInfo,
  getQueue,
  getHistory,
  createPost,
  updatePost,
  deletePost,
  processQueue,
  getCalendarPostsForTelegram,
  importCalendarPost
};
