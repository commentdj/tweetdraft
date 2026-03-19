// TweetDraft — generate.js
// Runs daily at 8am via GitHub Actions
// Generates 4 tweets, assigns time slots, commits queue.json, emails digest

const https = require("https");

const PERSONA = `You are ghostwriting daily tweets for a startup founder who validates business ideas. Voice: direct, grounded, founder-native — not corporate, not hustle-bro.

Generate exactly 4 tweets, one of each format:
- NUMBERED LIST: tight numbered list (3-5 items)
- SHORT TAKE: one punchy insight, 1-3 sentences, opinionated, no hedging
- PROBLEM DEEP-DIVE: honest about what's hard, thinking out loud
- OBSERVATION: dry, specific pattern from market or founder life

Rules: no emojis, never start with "I just", no motivational fluff. Sound like a real person.

Today's context: building with AI tools, validating startup ideas, removing friction from daily workflows, thinking about authenticity vs automation.

Return ONLY valid JSON, no preamble, no markdown:
{
  "tweets": [
    {"type": "NUMBERED LIST", "text": "..."},
    {"type": "SHORT TAKE", "text": "..."},
    {"type": "PROBLEM DEEP-DIVE", "text": "..."},
    {"type": "OBSERVATION", "text": "..."}
  ]
}`;

// Default posting schedule (UTC). Change to suit your timezone.
// 9am, 12pm, 3pm, 6pm UTC = 10am, 1pm, 4pm, 7pm BST
const TIME_SLOTS = ["09:00", "12:00", "15:00", "18:00"];

function post(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function callAnthropic() {
  const body = JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1200,
    messages: [{ role: "user", content: PERSONA }],
  });

  const res = await post(
    {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    body
  );

  const parsed = JSON.parse(res.body);
  const text = parsed.content?.[0]?.text || "";
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

async function commitQueueToRepo(queue) {
  const owner = process.env.GITHUB_REPOSITORY.split("/")[0];
  const repo = process.env.GITHUB_REPOSITORY.split("/")[1];
  const token = process.env.GITHUB_TOKEN;
  const content = Buffer.from(JSON.stringify(queue, null, 2)).toString("base64");
  const path = "queue.json";

  // Check if file exists to get its SHA (required for updates)
  let sha = undefined;
  const getRes = await post(
    {
      hostname: "api.github.com",
      path: `/repos/${owner}/${repo}/contents/${path}`,
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "TweetDraft",
        Accept: "application/vnd.github+json",
      },
    },
    null
  );
  if (getRes.status === 200) {
    sha = JSON.parse(getRes.body).sha;
  }

  const body = JSON.stringify({
    message: `TweetDraft: queue for ${new Date().toISOString().slice(0, 10)}`,
    content,
    ...(sha ? { sha } : {}),
  });

  const putRes = await post(
    {
      hostname: "api.github.com",
      path: `/repos/${owner}/${repo}/contents/${path}`,
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "TweetDraft",
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    body
  );

  if (putRes.status !== 200 && putRes.status !== 201) {
    throw new Error(`GitHub commit failed: ${putRes.status} ${putRes.body}`);
  }
  console.log("queue.json committed to repo");
}

async function sendEmail(subject, text) {
  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: process.env.TO_EMAIL,
    subject,
    text,
  });
}

async function main() {
  console.log("Generating tweets...");
  const result = await callAnthropic();
  const tweets = result.tweets || [];
  console.log(`Got ${tweets.length} tweets`);

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Build queue — status "pending" means waiting for approval
  const queue = {
    date: today,
    slots: tweets.map((t, i) => ({
      id: `${today}-${i}`,
      type: t.type,
      text: t.text,
      scheduledTime: `${today}T${TIME_SLOTS[i]}:00Z`,
      status: "pending", // pending | approved | posted | skipped
    })),
  };

  // Commit queue.json to repo
  await commitQueueToRepo(queue);

  // Format email
  const date = new Date().toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short",
  });

  const lines = queue.slots.map((s, i) => {
    const time = new Date(s.scheduledTime).toLocaleTimeString("en-GB", {
      hour: "2-digit", minute: "2-digit", timeZone: "UTC",
    });
    return `${i + 1}. [${s.type}] — scheduled ${time} UTC\n\n${s.text}\n\n(${s.text.length}/280 chars)`;
  });

  const emailText =
    `Your tweet drafts for ${date}\n` +
    `Tweets are scheduled to post automatically if approved in TweetDraft.\n\n` +
    "─".repeat(40) + "\n\n" +
    lines.join("\n\n" + "─".repeat(40) + "\n\n") +
    "\n\n" + "─".repeat(40) + "\n\n" +
    "Open TweetDraft in Claude to approve, reschedule, or skip each tweet.\n" +
    "Unapproved tweets will not post.";

  await sendEmail(`Tweet drafts ready — ${date}`, emailText);
  console.log("Email sent. Done.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
