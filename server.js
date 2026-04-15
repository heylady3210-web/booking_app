const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
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

// ── one-time OAuth2 helpers (run locally to generate refresh token) ──
// GET /auth-url  → prints the Google consent URL to visit
// GET /auth-token?code=XXX  → exchanges code for refresh token
app.get('/auth-url', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar.events'
    ]
  });
  res.send(`<p>Visit this URL to authorize:</p><a href="${url}" target="_blank">${url}</a>`);
});

app.get('/auth-token', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code parameter.');
  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.send(`
      <h2>Authorization successful!</h2>
      <p>Add this to your <code>.env</code> file on Railway:</p>
      <pre>GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}</pre>
      <p><strong>Copy it now</strong> — it won't be shown again.</p>
    `);
  } catch (e) {
    res.status(500).send('Token exchange failed: ' + e.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Booking server running on port ${PORT}`));
