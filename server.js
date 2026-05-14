// updated1
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const cron = require('node-cron');
const tg = require('./telegram');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// ── Google OAuth2 client ──
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob' // for one-time token generation
);
oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// ── helpers ──
function makeEmail({ to, subject, body }) {
  const raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body
  ].join('\n');
  return Buffer.from(raw).toString('base64url');
}

async function sendEmail({ to, subject, body }) {
  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: makeEmail({ to, subject, body }) }
  });
}

// ── health check ──
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Booking server is running.' });
});

// ── main endpoint ──
app.post('/post-booking', async (req, res) => {
  const {
    visitorName,
    visitorEmail,
    offeringLabel,
    offeringType,
    offeringDuration,
    date,
    time,
    endTime,
    creatorName,
    creatorEmail
  } = req.body;

  // Basic validation
  if (!visitorEmail || !visitorName || !offeringLabel || !date || !time || !creatorEmail) {
    return res.status(400).json({ error: 'Missing required booking fields.' });
  }

  const errors = [];

  // 1. Confirmation email to visitor
  try {
    await sendEmail({
      to: visitorEmail,
      subject: `Your booking with ${creatorName} is confirmed`,
      body: `Hi ${visitorName},

Your booking is confirmed. Here are the details:

  Session:  ${offeringLabel}
  Type:     ${offeringType.charAt(0).toUpperCase() + offeringType.slice(1)}
  Duration: ${offeringDuration} minutes
  Date:     ${date}
  Time:     ${time}

If you have any questions, just reply to this email.

Looking forward to connecting!
${creatorName}`
    });
  } catch (e) {
    errors.push(`Visitor email failed: ${e.message}`);
  }

  // 2. Notification email to creator
  try {
    await sendEmail({
      to: creatorEmail,
      subject: `New booking — ${offeringLabel}`,
      body: `You have a new booking.

  Visitor:  ${visitorName} (${visitorEmail})
  Offering: ${offeringLabel}
  Type:     ${offeringType.charAt(0).toUpperCase() + offeringType.slice(1)}
  Duration: ${offeringDuration} minutes
  Date:     ${date}
  Time:     ${time}`
    });
  } catch (e) {
    errors.push(`Creator email failed: ${e.message}`);
  }

  // 3. Google Calendar event
  try {
    // Parse date + time into RFC3339
    const startDateTime = `${date}T${time}:00`;
    const endDateTime = `${date}T${endTime}:00`;

    await calendar.events.insert({
      calendarId: 'primary',
      sendUpdates: 'all', // sends Google Calendar invite to attendee
      requestBody: {
        summary: `${offeringLabel} with ${visitorName}`,
        description: `${offeringType.charAt(0).toUpperCase() + offeringType.slice(1)} conversation.\nVisitor: ${visitorName} (${visitorEmail})`,
        start: { dateTime: startDateTime, timeZone: process.env.TIMEZONE || 'America/New_York' },
        end: { dateTime: endDateTime, timeZone: process.env.TIMEZONE || 'America/New_York' },
        attendees: [{ email: visitorEmail }]
      }
    });
  } catch (e) {
    errors.push(`Calendar event failed: ${e.message}`);
  }

  if (errors.length > 0) {
    return res.status(207).json({
      status: 'partial',
      message: 'Some post-booking actions failed.',
      errors
    });
  }

  res.json({ status: 'ok', message: 'Emails sent and calendar event created.' });
});

// ── debug endpoint ──
app.get('/debug', async (req, res) => {
  const info = {
    env: {
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ? process.env.GOOGLE_CLIENT_ID.slice(0, 20) + '...' : 'NOT SET',
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ? process.env.GOOGLE_CLIENT_SECRET.slice(0, 6) + '...' : 'NOT SET',
      GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN ? process.env.GOOGLE_REFRESH_TOKEN.slice(0, 20) + '...' : 'NOT SET',
      TIMEZONE: process.env.TIMEZONE || 'NOT SET'
    }
  };

  // Try to get an access token to confirm credentials work
  try {
    const { token } = await oauth2Client.getAccessToken();
    info.accessToken = token ? 'OK — got access token successfully' : 'EMPTY — no token returned';
  } catch (e) {
    info.accessToken = 'FAILED: ' + e.message;
  }

  res.json(info);
});

// ── one-time OAuth2 helpers ──
// Use a fresh client for token exchange so it doesn't interfere with the main client
app.get('/auth-url', (req, res) => {
  const authClient = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
  );
  const url = authClient.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar.events'
    ]
  });
  res.send(`
    <h2>Step 1: Authorize Google Access</h2>
    <p>Click the link below and sign in with the Gmail account you want to send emails from.</p>
    <p><a href="${url}" target="_blank" style="font-size:18px">${url}</a></p>
    <p>After approving, you will be shown a code. Copy it and visit:<br>
    <code>https://${req.headers.host}/auth-token?code=PASTE_CODE_HERE</code></p>
  `);
});

app.get('/auth-token', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code parameter. Visit /auth-url first.');
  const authClient = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
  );
  try {
    const { tokens } = await authClient.getToken(decodeURIComponent(code));
    if (!tokens.refresh_token) {
      return res.send(`
        <h2>No refresh token returned</h2>
        <p>This usually means the account was already authorized before. To force a new refresh token:</p>
        <ol>
          <li>Go to <a href="https://myaccount.google.com/permissions" target="_blank">https://myaccount.google.com/permissions</a></li>
          <li>Find your app and click <strong>Remove Access</strong></li>
          <li>Then visit <a href="/auth-url">/auth-url</a> and authorize again</li>
        </ol>
      `);
    }
    res.send(`
      <h2>Success! Here is your refresh token:</h2>
      <textarea rows="4" cols="80" onclick="this.select()">${tokens.refresh_token}</textarea>
      <h3>Next steps:</h3>
      <ol>
        <li>Copy the token above</li>
        <li>Go to Railway → Variables → set <code>GOOGLE_REFRESH_TOKEN</code> to this value</li>
        <li>Railway will redeploy automatically</li>
        <li>Visit <a href="/debug">/debug</a> to confirm it's loaded correctly</li>
      </ol>
    `);
  } catch (e) {
    res.status(500).send(`
      <h2>Token exchange failed</h2>
      <p><strong>Error:</strong> ${e.message}</p>
      <p>The authorization code may have expired (they last ~60 seconds). 
      Please <a href="/auth-url">start over</a>.</p>
    `);
  }
});

// ── dashboard: mailerlite stats proxy ──
app.get('/dashboard/mailerlite-stats', async (req, res) => {
  if (req.query.key !== process.env.DASHBOARD_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.MAILERLITE_API_KEY}`
    };
    const [subsRes, campsRes] = await Promise.all([
      fetch('https://connect.mailerlite.com/api/subscribers?limit=1', { headers }),
      fetch('https://connect.mailerlite.com/api/campaigns?filter[status]=sent&limit=5&sort=-sent_at', { headers })
    ]);
    const [subsData, campsData] = await Promise.all([subsRes.json(), campsRes.json()]);
    res.json({
      total_subscribers: subsData.meta?.total ?? 0,
      campaigns: (campsData.data || []).map(c => ({
        name: c.name,
        sent_at: c.sent_at,
        open_rate: c.stats?.open_rate?.float ?? 0,
        click_rate: c.stats?.click_rate?.float ?? 0,
        unsubscribe_count: c.stats?.unsubscribed ?? 0
      }))
    });
  } catch (err) {
    console.error('MailerLite stats error:', err);
    res.status(500).json({ error: 'Failed to fetch MailerLite stats' });
  }
});

app.post('/newsletter/subscribe', async (req, res) => {
  const { first_name, email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const response = await fetch('https://connect.mailerlite.com/api/subscribers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.MAILERLITE_API_KEY}`
      },
      body: JSON.stringify({
        email,
        fields: { name: first_name },
        groups: [process.env.MAILERLITE_GROUP_ID]
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json({ success: true });

  } catch (err) {
    console.error('MailerLite error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});
// ── Age verification webhook (Persona) ──────────────────────────────────────
// Persona calls this URL when a verification inquiry completes.
// Configure the webhook in your Persona dashboard:
//   URL: https://[railway-url]/verify/webhook
//   Events: inquiry.completed, inquiry.failed
app.post('/verify/webhook', (req, res) => {
  const event = req.body;
  const inquiryId = event?.data?.attributes?.['inquiry-id'] || event?.data?.id || 'unknown';
  const status    = event?.data?.attributes?.status || 'unknown';

  console.log(`[AgeVerify] Webhook received — inquiry: ${inquiryId}, status: ${status}`);

  // Acknowledge receipt immediately so Persona doesn't retry
  res.status(200).json({ received: true });
});

// ── Telegram: auth middleware ────────────────────────────────────────────────
function requireDashboardKey(req, res, next) {
  const key = req.headers['x-dashboard-key'] || req.query.key;
  if (!process.env.DASHBOARD_KEY || key !== process.env.DASHBOARD_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Telegram: settings / bot health ─────────────────────────────────────────
app.get('/telegram/settings', requireDashboardKey, async (req, res) => {
  const botInfo = await tg.getBotInfo();
  res.json({
    bot: botInfo,
    channel_id: process.env.TELEGRAM_CHANNEL_ID || null,
    token_set: !!process.env.TELEGRAM_BOT_TOKEN,
    service_key_set: !!process.env.SUPABASE_SERVICE_KEY
  });
});

// ── Telegram: queue ──────────────────────────────────────────────────────────
app.get('/telegram/queue', requireDashboardKey, async (req, res) => {
  try {
    const posts = await tg.getQueue();
    res.json(posts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Telegram: create post ────────────────────────────────────────────────────
app.post('/telegram/posts', requireDashboardKey, async (req, res) => {
  const { caption, image_url, video_url, media_type, scheduled_at } = req.body;
  if (!caption) return res.status(400).json({ error: 'caption required' });
  if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at required' });
  try {
    const post = await tg.createPost({
      source: 'manual',
      caption,
      image_url: image_url || null,
      video_url: video_url || null,
      media_type: media_type || 'text',
      status: 'queued',
      scheduled_at
    });
    res.status(201).json(post);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Telegram: update post (edit caption / schedule / status) ─────────────────
app.patch('/telegram/posts/:id', requireDashboardKey, async (req, res) => {
  const allowed = ['caption', 'image_url', 'video_url', 'media_type', 'scheduled_at', 'status'];
  const fields = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  if (!Object.keys(fields).length) return res.status(400).json({ error: 'No valid fields to update' });
  try {
    const post = await tg.updatePost(req.params.id, fields);
    res.json(post);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Telegram: delete post (queued/paused only) ───────────────────────────────
app.delete('/telegram/posts/:id', requireDashboardKey, async (req, res) => {
  try {
    await tg.deletePost(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Telegram: send now ───────────────────────────────────────────────────────
app.post('/telegram/posts/:id/send-now', requireDashboardKey, async (req, res) => {
  try {
    const queue = await tg.getQueue();
    const post = queue.find(p => p.id === req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found in queue' });
    const result = await tg.sendPost(post);
    await tg.updatePost(post.id, {
      status: 'sent',
      sent_at: new Date().toISOString(),
      telegram_message_id: result.message_id
    });
    res.json({ ok: true, telegram_message_id: result.message_id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Telegram: history ────────────────────────────────────────────────────────
app.get('/telegram/history', requireDashboardKey, async (req, res) => {
  try {
    const posts = await tg.getHistory(50);
    res.json(posts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Telegram: calendar import — list importable posts ───────────────────────
app.get('/telegram/calendar-posts', requireDashboardKey, async (req, res) => {
  try {
    const posts = await tg.getCalendarPostsForTelegram();
    res.json(posts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Telegram: calendar import — import selected posts ────────────────────────
app.post('/telegram/import', requireDashboardKey, async (req, res) => {
  const { posts } = req.body; // [{ id, caption, visual, date, scheduled_time }]
  if (!Array.isArray(posts) || !posts.length) return res.status(400).json({ error: 'posts array required' });
  const results = [];
  for (const p of posts) {
    try {
      const scheduledAt = p.scheduled_at || `${p.date}T12:00:00Z`;
      const row = await tg.importCalendarPost(p, scheduledAt);
      results.push({ id: p.id, ok: true, telegram_post_id: row?.id });
    } catch (e) {
      results.push({ id: p.id, ok: false, error: e.message });
    }
  }
  res.json(results);
});

// ── Telegram: cron — process queue every minute ──────────────────────────────
cron.schedule('* * * * *', () => {
  tg.processQueue().catch(e => console.error('[Telegram cron]', e.message));
});
console.log('[Telegram] Queue cron started — checking every 60s');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Booking server running on port ${PORT}`));
