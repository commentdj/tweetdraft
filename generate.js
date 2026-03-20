// TweetDraft — generate.js v5
// Reads context.json (scraped from Claude by bookmarklet)
// Reads posted-log.json to avoid repeating topics
// Generates 6 tweets, commits queue.json, emails digest

const https = require("https");

const TIME_SLOTS = ["02:00", "06:00", "10:00", "14:00", "18:00", "22:00"];

function httpRequest(options, body) {
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

const TOKEN = process.env.GITHUB_TOKEN;
const [OWNER, REPO] = (process.env.GITHUB_REPOSITORY || "/").split("/");

async function ghGet(path) {
  const res = await httpRequest({
    hostname: "api.github.com",
    path: `/repos/${OWNER}/${REPO}/contents/${path}`,
    method: "GET",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "User-Agent": "TweetDraft",
      Accept: "application/vnd.github+json",
    },
  }, null);
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`ghGet ${path} failed: ${res.status}`);
  return JSON.parse(res.body);
}

async function ghPut(path, content, sha, message) {
  const encoded = Buffer.from(content).toString("base64");
  const payload = { message, content: encoded };
  if (sha) payload.sha = sha;
  const body = JSON.stringify(payload);
  const res = await httpRequest({
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
  }, body);
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`ghPut ${path} failed: ${res.status} — ${res.body}`);
  }
  return JSON.parse(res.body);
}

function decodeFile(file) {
  return Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8");
}

// ── Read Claude context from bookmarklet ──────────────────────────────────────
async function getClaudeContext() {
  const file = await ghGet("context.json");
  if (!file) {
    console.log("No context.json found — using fallback");
    return {
      text: "No specific Claude session context available today. Write about general startup founder topics: idea validation, talking to users, building with AI, removing friction.",
      date: "unknown",
    };
  }
  const data = JSON.parse(decodeFile(file));
  const text = data.context || "";
  console.log(`Context from ${data.date} (${text.length} chars)`);
  return { text, date: data.date || "unknown" };
}

// ── Read posted log ───────────────────────────────────────────────────────────
async function getRecentPostsContext() {
  const file = await ghGet("posted-log.json");
  if (!file) return "No previous tweets posted yet.";
  const log = JSON.parse(decodeFile(file));
  const posts = (log.posts || []).slice(-30).reverse();
  if (posts.length === 0) return "No previous tweets posted yet.";
  const lines = posts.map((p, i) =>
    `${i + 1}. [${p.type}] (${(p.postedAt || "").slice(0, 10)})\n${p.text}`
  );
  return `Last ${posts.length} posted tweets:\n\n` + lines.join("\n\n");
}

// ── Generate ──────────────────────────────────────────────────────────────────
async function callAnthropic(claudeContext, recentPosts) {
  const prompt = `You are ghostwriting daily tweets for a startup founder who validates business ideas. Voice: direct, grounded, founder-native — not corporate, not hustle-bro.

TODAY'S RAW MATERIAL — scraped directly from this founder's Claude conversation today:
---
${claudeContext}
---

Read through that and extract the most interesting insights, problems, observations, and ideas. Use it as the raw material for tweets. The tweets should feel like genuine reflections on real work done today — not generic startup advice.

Generate exactly 6 tweets across these formats (mix them — don't repeat formats back to back):
- NUMBERED LIST: tight numbered list (3-5 items) based on something from today's session
- SHORT TAKE: one punchy insight pulled directly from the context, 1-3 sentences, opinionated
- PROBLEM DEEP-DIVE: an honest take on a real problem touched on in the context
- OBSERVATION: a dry, specific pattern noticed through the work described

Rules:
- No emojis
- Never start with "I just"
- No motivational fluff
- Each tweet under 280 characters
- Sound like a real person reflecting on real work, not performing

AVOID REPEATING — these have already been posted:
${recentPosts}

Do not repeat topics, angles, or phrasing from the already-posted tweets above.

Return ONLY valid JSON, no preamble, no markdown:
{
  "tweets": [
    {"type": "SHORT TAKE", "text": "..."},
    {"type": "NUMBERED LIST", "text": "..."},
    {"type": "OBSERVATION", "text": "..."},
    {"type": "PROBLEM DEEP-DIVE", "text": "..."},
    {"type": "SHORT TAKE", "text": "..."},
    {"type": "NUMBERED LIST", "text": "..."}
  ]
}`;

  const reqBody = JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1800,
    messages: [{ role: "user", content: prompt }],
  });

  const res = await httpRequest({
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Length": Buffer.byteLength(reqBody),
    },
  }, reqBody);

  if (res.status !== 200) throw new Error(`Anthropic error: ${res.status} — ${res.body}`);

  const parsed = JSON.parse(res.body);
  const text = parsed.content?.[0]?.text || "";
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON in Claude response");
  return JSON.parse(clean.slice(start, end + 1));
}

// ── Commit queue ──────────────────────────────────────────────────────────────
async function commitQueue(queue) {
  const existing = await ghGet("queue.json").catch(() => null);
  const sha = existing ? existing.sha : undefined;
  await ghPut("queue.json", JSON.stringify(queue, null, 2), sha, `TweetDraft: queue for ${queue.date}`);
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
  console.log("Reading Claude context...");
  const { text: claudeContext, date: contextDate } = await getClaudeContext();

  console.log("Reading posted log...");
  const recentPosts = await getRecentPostsContext();

  console.log("Generating tweets...");
  const result = await callAnthropic(claudeContext, recentPosts);
  const tweets = result.tweets || [];
  console.log(`Got ${tweets.length} tweets`);

  const today = new Date().toISOString().slice(0, 10);
  const queue = {
    date: today,
    contextDate,
    slots: tweets.map((t, i) => ({
      id: `${today}-${i}`,
      type: t.type,
      text: t.text,
      scheduledTime: `${today}T${TIME_SLOTS[i] || "12:00"}:00Z`,
      status: "pending",
    })),
  };

  await commitQueue(queue);

  const date = new Date().toLocaleDateString("en-GB", { weekday:"short", day:"numeric", month:"short" });
  const lines = queue.slots.map((s, i) => {
    const utc = s.scheduledTime.substring(11, 16);
    const bstH = (parseInt(utc.split(":")[0]) + 1) % 24;
    const bst = String(bstH).padStart(2, "0") + ":" + utc.split(":")[1];
    return `${i + 1}. [${s.type}]  UTC ${utc} / BST ${bst}\n\n${s.text}\n\n(${s.text.length}/280)`;
  });

  await sendEmail(
    `${tweets.length} tweet drafts — ${date}`,
    `Based on your Claude session from ${contextDate}.\nOpen tweetdraft-approve.html to approve.\n\n` +
    "─".repeat(40) + "\n\n" +
    lines.join("\n\n" + "─".repeat(40) + "\n\n")
  );

  console.log("Done.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
