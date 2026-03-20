// TweetDraft — generate.js v3
// Reads posted-log.json to avoid repeating topics/angles.
// Generates 6 tweets spread across 24 hours, commits queue.json, emails digest.

const https = require("https");

// 6 slots evenly across 24 hours (UTC)
const TIME_SLOTS = ["02:00", "06:00", "10:00", "14:00", "18:00", "22:00"];

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

// ── GitHub helpers ────────────────────────────────────────────────────────────
const TOKEN = process.env.GITHUB_TOKEN;
const [OWNER, REPO] = (process.env.GITHUB_REPOSITORY || "/").split("/");

async function ghGet(path) {
  const res = await post(
    {
      hostname: "api.github.com",
      path: `/repos/${OWNER}/${REPO}/contents/${path}`,
      method: "GET",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "User-Agent": "TweetDraft",
        Accept: "application/vnd.github+json",
      },
    },
    null
  );
  if (res.status === 404) return null;
  return JSON.parse(res.body);
}

async function ghPut(path, content, sha, message) {
  const encoded = Buffer.from(content).toString("base64");
  const body = JSON.stringify({ message, content: encoded, ...(sha ? { sha } : {}) });
  const res = await post(
    {
      hostname: "api.github.com",
      path: `/repos/${OWNER}/${REPO}/contents/${path}`,
      method: "PUT",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "User-Agent": "TweetDraft",
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    body
  );
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`GitHub write failed ${res.status}`);
  }
  return JSON.parse(res.body);
}

// ── Read posted log ───────────────────────────────────────────────────────────
async function getRecentPostsContext() {
  const file = await ghGet("posted-log.json");
  if (!file) return "No previous tweets posted yet.";

  const raw = Buffer.from(file.content, "base64").toString("utf8");
  const log = JSON.parse(raw);
  const posts = log.posts || [];

  if (posts.length === 0) return "No previous tweets posted yet.";

  // Last 30 posts (most recent first) — enough context without blowing token budget
  const recent = posts.slice(-30).reverse();
  const lines = recent.map((p, i) =>
    `${i + 1}. [${p.type}] (${p.postedAt ? p.postedAt.slice(0, 10) : "unknown date"})\n${p.text}`
  );

  return `Last ${recent.length} posted tweets (most recent first):\n\n` + lines.join("\n\n");
}

// ── Generate tweets ───────────────────────────────────────────────────────────
async function callAnthropic(recentContext) {
  const persona = `You are ghostwriting daily tweets for a startup founder who validates business ideas. Voice: direct, grounded, founder-native — not corporate, not hustle-bro.

Generate exactly 6 tweets across these formats (mix them — don't do all the same):
- NUMBERED LIST: tight numbered list (3-5 items)
- SHORT TAKE: one punchy insight, 1-3 sentences, opinionated, no hedging
- PROBLEM DEEP-DIVE: honest about what's hard, thinking out loud
- OBSERVATION: dry, specific pattern from market or founder life

Rules:
- No emojis
- Never start with "I just"
- No motivational fluff
- Sound like a real person, not performing for an audience
- Each tweet under 280 characters

IMPORTANT — avoid repeating yourself:
${recentContext}

Do not repeat topics, angles, or phrasing from the above. Find fresh angles, new observations, different problems. The audience sees every tweet — repetition kills credibility.

Today's broad context: building with AI tools, validating startup ideas, removing friction from daily workflows.

Return ONLY valid JSON, no preamble, no markdown:
{
  "tweets": [
    {"type": "...", "text": "..."},
    {"type": "...", "text": "..."},
    {"type": "...", "text": "..."},
    {"type": "...", "text": "..."},
    {"type": "...", "text": "..."},
    {"type": "...", "text": "..."}
  ]
}`;

  const reqBody = JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1800,
    messages: [{ role: "user", content: persona }],
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
        "Content-Length": Buffer.byteLength(reqBody),
      },
    },
    reqBody
  );

  const parsed = JSON.parse(res.body);
  const text = parsed.content?.[0]?.text || "";
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  return JSON.parse(clean.slice(start, end + 1));
}

// ── Commit queue ──────────────────────────────────────────────────────────────
async function commitQueue(queue) {
  const existing = await ghGet("queue.json");
  const sha = existing ? existing.sha : undefined;
  await ghPut(
    "queue.json",
    JSON.stringify(queue, null, 2),
    sha,
    `TweetDraft: queue for ${queue.date}`
  );
  console.log("queue.json committed");
}

// ── Email ─────────────────────────────────────────────────────────────────────
async function sendEmail(subject, text) {
  const nodemailer = require("nodemailer");
  const t = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  await t.sendMail({ from: process.env.GMAIL_USER, to: process.env.TO_EMAIL, subject, text });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Reading posted log...");
  const recentContext = await getRecentPostsContext();
  console.log("Generating tweets (with dedup context)...");

  const result = await callAnthropic(recentContext);
  const tweets = result.tweets || [];
  console.log(`Got ${tweets.length} tweets`);

  const today = new Date().toISOString().slice(0, 10);

  const queue = {
    date: today,
    slots: tweets.map((t, i) => ({
      id: `${today}-${i}`,
      type: t.type,
      text: t.text,
      scheduledTime: `${today}T${TIME_SLOTS[i] || "12:00"}:00Z`,
      status: "pending",
    })),
  };

  await commitQueue(queue);

  // Format email — include BST times
  const date = new Date().toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short",
  });
  const lines = queue.slots.map((s, i) => {
    const utc = s.scheduledTime.substring(11, 16);
    const bstH = (parseInt(utc.split(":")[0]) + 1) % 24;
    const bst = String(bstH).padStart(2, "0") + ":" + utc.split(":")[1];
    return `${i + 1}. [${s.type}]  UTC ${utc} / BST ${bst}\n\n${s.text}\n\n(${s.text.length}/280)`;
  });

  await sendEmail(
    `${tweets.length} tweet drafts — ${date}`,
    `Fresh drafts for ${date}. Open tweetdraft-approve.html to approve.\n\n` +
    "─".repeat(40) + "\n\n" +
    lines.join("\n\n" + "─".repeat(40) + "\n\n")
  );

  console.log("Done.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
