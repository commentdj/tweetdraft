// TweetDraft — generate.js v6
// Weekly batch: reads Notion pages updated in last 7 days as context
// Generates 42 tweets (6/day x 7 days), commits to queue.json, emails digest

const https = require("https");

// 6 slots per day spread across 24 hours (UTC)
const DAILY_SLOTS = ["02:00", "06:00", "10:00", "14:00", "18:00", "22:00"];
const DAYS = 7;
const TWEETS_PER_DAY = 6;

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

// ── GitHub helpers ────────────────────────────────────────────────────────────
const GH_TOKEN = process.env.GITHUB_TOKEN;
const [OWNER, REPO] = (process.env.GITHUB_REPOSITORY || "/").split("/");

async function ghGet(path) {
  const res = await httpRequest({
    hostname: "api.github.com",
    path: `/repos/${OWNER}/${REPO}/contents/${path}`,
    method: "GET",
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
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
      Authorization: `Bearer ${GH_TOKEN}`,
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

function decodeGhFile(file) {
  return Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8");
}

// ── Notion API ────────────────────────────────────────────────────────────────
const NOTION_KEY = process.env.NOTION_API_KEY;

async function notionRequest(method, path, body) {
  const bodyStr = body ? JSON.stringify(body) : null;
  const res = await httpRequest({
    hostname: "api.notion.com",
    path: path,
    method: method,
    headers: {
      Authorization: `Bearer ${NOTION_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
      "User-Agent": "TweetDraft",
      ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
    },
  }, bodyStr);
  if (res.status !== 200) throw new Error(`Notion ${method} ${path} failed: ${res.status} — ${res.body}`);
  return JSON.parse(res.body);
}

// Search for pages edited in last 7 days
async function getRecentNotionPages() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const result = await notionRequest("POST", "/v1/search", {
    filter: { value: "page", property: "object" },
    sort: { direction: "descending", timestamp: "last_edited_time" },
    page_size: 20,
  });

  const pages = (result.results || []).filter(p => {
    return p.last_edited_time && p.last_edited_time > sevenDaysAgo;
  });

  console.log(`Found ${pages.length} Notion pages updated in last 7 days`);
  return pages;
}

// Extract plain text from a Notion block
function blockToText(block) {
  const type = block.type;
  if (!block[type]) return "";
  const richText = block[type].rich_text || [];
  return richText.map(t => t.plain_text || "").join("");
}

// Get all text content from a page
async function getPageContent(pageId, pageTitle) {
  try {
    const result = await notionRequest("GET", `/v1/blocks/${pageId}/children?page_size=100`, null);
    const blocks = result.results || [];
    const lines = blocks
      .map(blockToText)
      .filter(t => t.trim().length > 0);
    if (lines.length === 0) return null;
    return `[${pageTitle}]\n${lines.join("\n")}`;
  } catch (e) {
    console.log(`Could not read page ${pageId}: ${e.message}`);
    return null;
  }
}

// Get page title from Notion page object
function getPageTitle(page) {
  try {
    const props = page.properties || {};
    // Try common title property names
    const titleProp = props.title || props.Title || props.Name || props.name;
    if (titleProp && titleProp.title) {
      return titleProp.title.map(t => t.plain_text).join("") || "Untitled";
    }
    // Try any property of type title
    for (const key of Object.keys(props)) {
      if (props[key].type === "title" && props[key].title) {
        return props[key].title.map(t => t.plain_text).join("") || "Untitled";
      }
    }
  } catch (e) {}
  return "Untitled";
}

async function getNotionContext() {
  try {
    const pages = await getRecentNotionPages();
    if (pages.length === 0) {
      console.log("No recent Notion pages found — using fallback context");
      return "No Notion pages updated this week. Write about general startup founder topics: idea validation, talking to users, building with AI, removing friction from workflows.";
    }

    const contents = [];
    for (const page of pages.slice(0, 10)) { // max 10 pages
      const title = getPageTitle(page);
      const content = await getPageContent(page.id, title);
      if (content) {
        contents.push(content);
        console.log(`  ✓ "${title}" (${content.length} chars)`);
      }
    }

    if (contents.length === 0) {
      return "Notion pages found but could not read content. Make sure TweetDraft integration has access to your pages.";
    }

    let combined = contents.join("\n\n---\n\n");
    // Cap at 8000 chars to stay within token budget
    if (combined.length > 8000) {
      combined = combined.substring(0, 8000) + "\n...[truncated]";
    }

    console.log(`Total context: ${combined.length} chars from ${contents.length} pages`);
    return combined;

  } catch (e) {
    console.log(`Notion error: ${e.message} — using fallback`);
    return `Could not read Notion (${e.message}). Write about general startup founder topics: idea validation, talking to users, building with AI, removing friction.`;
  }
}

// ── Read posted log ───────────────────────────────────────────────────────────
async function getRecentPostsContext() {
  const file = await ghGet("posted-log.json");
  if (!file) return "No previous tweets posted yet.";
  const log = JSON.parse(decodeGhFile(file));
  const posts = (log.posts || []).slice(-50).reverse();
  if (posts.length === 0) return "No previous tweets posted yet.";
  const lines = posts.map((p, i) =>
    `${i + 1}. [${p.type}] (${(p.postedAt || "").slice(0, 10)})\n${p.text}`
  );
  return `Last ${posts.length} posted tweets:\n\n` + lines.join("\n\n");
}

// ── Generate tweets ───────────────────────────────────────────────────────────
async function generateBatch(notionContext, recentPosts, startDate, dayIndex) {
  const dateStr = startDate.toISOString().slice(0, 10);

  const prompt = `You are ghostwriting tweets for a startup founder who validates business ideas. Voice: direct, grounded, founder-native — not corporate, not hustle-bro.

HERE IS WHAT THIS FOUNDER HAS BEEN WORKING ON (from their Notion workspace this week):
---
${notionContext}
---

Use this as raw material. Extract real insights, problems, observations, and lessons from it. Tweets should feel like genuine reflections on actual work — not generic startup advice.

Generate exactly ${TWEETS_PER_DAY} tweets for day ${dayIndex + 1} of 7 (${dateStr}).

Use these formats, mixed up — no two consecutive tweets the same format:
- NUMBERED LIST: tight numbered list (3-5 items) from something real in the notes
- SHORT TAKE: one punchy insight from the work, 1-3 sentences, opinionated
- PROBLEM DEEP-DIVE: honest take on a real problem from the notes, thinking out loud
- OBSERVATION: dry, specific pattern noticed through the work

Rules:
- No emojis
- Never start with "I just"
- No motivational fluff
- Each tweet under 280 characters
- Sound like a real person, not performing

ALREADY POSTED — do not repeat these topics or angles:
${recentPosts}

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
    max_tokens: 2000,
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
  if (start === -1 || end === -1) throw new Error(`No JSON in response for day ${dayIndex + 1}`);
  return JSON.parse(clean.slice(start, end + 1)).tweets || [];
}

// ── Commit queue ──────────────────────────────────────────────────────────────
async function commitQueue(queue) {
  const existing = await ghGet("queue.json").catch(() => null);
  const sha = existing ? existing.sha : undefined;
  await ghPut(
    "queue.json",
    JSON.stringify(queue, null, 2),
    sha,
    `TweetDraft: weekly queue ${queue.startDate} to ${queue.endDate}`
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
  await t.sendMail({
    from: process.env.GMAIL_USER,
    to: process.env.TO_EMAIL,
    subject,
    text,
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== TweetDraft Weekly Batch ===");

  // Read Notion context
  console.log("\n[1/4] Reading Notion...");
  const notionContext = await getNotionContext();

  // Read posted log
  console.log("\n[2/4] Reading posted log...");
  const recentPosts = await getRecentPostsContext();

  // Generate 7 days of tweets
  console.log("\n[3/4] Generating 42 tweets (7 days × 6)...");
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const allSlots = [];

  for (let day = 0; day < DAYS; day++) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() + day);
    const dateStr = date.toISOString().slice(0, 10);

    console.log(`  Generating day ${day + 1}/7 (${dateStr})...`);

    // Small delay between API calls to be polite
    if (day > 0) await new Promise(r => setTimeout(r, 1500));

    const tweets = await generateBatch(notionContext, recentPosts, date, day);

    tweets.forEach((t, i) => {
      allSlots.push({
        id: `${dateStr}-${i}`,
        type: t.type,
        text: t.text,
        scheduledTime: `${dateStr}T${DAILY_SLOTS[i] || "12:00"}:00Z`,
        status: "pending",
      });
    });

    console.log(`  ✓ Day ${day + 1}: ${tweets.length} tweets`);
  }

  const startDate = today.toISOString().slice(0, 10);
  const endDate = new Date(today.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const queue = {
    startDate,
    endDate,
    generatedAt: new Date().toISOString(),
    notionPageCount: (notionContext.match(/\[.*?\]/g) || []).length,
    totalSlots: allSlots.length,
    slots: allSlots,
  };

  // Commit queue
  console.log("\n[4/4] Committing queue.json...");
  await commitQueue(queue);

  // Build email summary
  const dayGroups = {};
  allSlots.forEach(s => {
    const d = s.scheduledTime.slice(0, 10);
    if (!dayGroups[d]) dayGroups[d] = [];
    dayGroups[d].push(s);
  });

  const emailLines = Object.keys(dayGroups).map(date => {
    const dayDate = new Date(date + "T12:00:00Z");
    const dayLabel = dayDate.toLocaleDateString("en-GB", { weekday:"short", day:"numeric", month:"short" });
    const tweets = dayGroups[date].map((s, i) => {
      const utc = s.scheduledTime.substring(11, 16);
      const bstH = (parseInt(utc.split(":")[0]) + 1) % 24;
      const bst = String(bstH).padStart(2, "0") + ":" + utc.split(":")[1];
      return `  ${i+1}. [${s.type}] UTC ${utc}/BST ${bst}\n     ${s.text.substring(0,80)}${s.text.length>80?"...":""}`;
    });
    return `── ${dayLabel} ──\n${tweets.join("\n")}`;
  });

  await sendEmail(
    `${allSlots.length} tweet drafts ready — ${startDate} to ${endDate}`,
    `Weekly batch generated from your Notion workspace.\n` +
    `Open tweetdraft-approve.html to review and approve.\n\n` +
    emailLines.join("\n\n")
  );

  console.log(`\n✓ Done. ${allSlots.length} tweets queued from ${startDate} to ${endDate}`);
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
