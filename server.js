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

const PORT = process.env.PORT || 3000;
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
app.listen(PORT, () => console.log(`Booking server running on port ${PORT}`));
