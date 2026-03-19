// TweetDraft — poster.js v3
// Runs hourly. Posts approved tweets, appends to posted-log.json.

const https = require("https");
const crypto = require("crypto");

function request(options, body) {
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

// ── OAuth 1.0a ────────────────────────────────────────────────────────────────
function oauthHeader(method, url) {
  const enc = (s) => encodeURIComponent(String(s));
  const p = {
    oauth_consumer_key: process.env.TWITTER_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: process.env.TWITTER_ACCESS_TOKEN,
    oauth_version: "1.0",
  };
  const paramStr = Object.keys(p).sort().map((k) => `${enc(k)}=${enc(p[k])}`).join("&");
  const base = [method.toUpperCase(), enc(url), enc(paramStr)].join("&");
  const sigKey = `${enc(process.env.TWITTER_API_SECRET)}&${enc(process.env.TWITTER_ACCESS_TOKEN_SECRET)}`;
  p.oauth_signature = crypto.createHmac("sha1", sigKey).update(base).digest("base64");
  return "OAuth " + Object.keys(p).sort().map((k) => `${enc(k)}="${enc(p[k])}"`).join(", ");
}

async function postTweet(text) {
  const url = "https://api.twitter.com/2/tweets";
  const body = JSON.stringify({ text });
  const res = await request(
    {
      hostname: "api.twitter.com",
      path: "/2/tweets",
      method: "POST",
      headers: {
        Authorization: oauthHeader("POST", url),
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    body
  );
  if (res.status !== 201 && res.status !== 200) {
    const e = JSON.parse(res.body);
    throw new Error(e.detail || e.title || `HTTP ${res.status}`);
  }
  return JSON.parse(res.body);
}

// ── GitHub helpers ────────────────────────────────────────────────────────────
const [OWNER, REPO] = (process.env.GITHUB_REPOSITORY || "/").split("/");
const TOKEN = process.env.GITHUB_TOKEN;

async function ghGet(path) {
  const res = await request(
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
  const res = await request(
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
    throw new Error(`GitHub write failed ${res.status}: ${res.body}`);
  }
  return JSON.parse(res.body);
}

async function readJSON(path) {
  const file = await ghGet(path);
  if (!file) return { data: null, sha: null };
  const content = Buffer.from(file.content, "base64").toString("utf8");
  return { data: JSON.parse(content), sha: file.sha };
}

// ── Posted log ────────────────────────────────────────────────────────────────
async function appendToLog(entries) {
  const { data, sha } = await readJSON("posted-log.json");

  const log = data || { posts: [] };
  log.posts.push(...entries);

  // Keep last 500 entries to stop the file growing forever
  if (log.posts.length > 500) {
    log.posts = log.posts.slice(-500);
  }

  await ghPut(
    "posted-log.json",
    JSON.stringify(log, null, 2),
    sha,
    `TweetDraft: logged ${entries.length} post(s) at ${new Date().toISOString()}`
  );
  console.log(`Appended ${entries.length} entry/entries to posted-log.json`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date();
  console.log(`Poster running at ${now.toISOString()}`);

  const { data: queue, sha: queueSha } = await readJSON("queue.json");
  if (!queue) {
    console.log("No queue.json — nothing to do.");
    return;
  }

  let posted = 0;
  let changed = false;
  const newLogEntries = [];

  for (const slot of queue.slots) {
    if (slot.status !== "approved") {
      console.log(`[${slot.type}] ${slot.status} — skip`);
      continue;
    }

    const scheduledAt = new Date(slot.scheduledTime);
    if (now < scheduledAt) {
      const mins = Math.round((scheduledAt - now) / 60000);
      console.log(`[${slot.type}] in ${mins} mins — not yet`);
      continue;
    }

    try {
      console.log(`Posting [${slot.type}]: "${slot.text.substring(0, 60)}..."`);
      const result = await postTweet(slot.text);

      slot.status = "posted";
      slot.postedAt = now.toISOString();
      if (result.data?.id) slot.tweetId = result.data.id;

      newLogEntries.push({
        id: slot.id,
        tweetId: result.data?.id || null,
        type: slot.type,
        text: slot.text,
        scheduledTime: slot.scheduledTime,
        postedAt: now.toISOString(),
      });

      posted++;
      changed = true;
      console.log(`✓ Posted (tweet id: ${result.data?.id})`);

      if (posted > 1) await new Promise((r) => setTimeout(r, 3000));
    } catch (e) {
      console.error(`✗ Failed: ${e.message}`);
      if (e.message.includes("duplicate")) {
        slot.status = "posted";
        slot.note = "duplicate — skipped";
      } else {
        slot.status = "failed";
        slot.error = e.message;
      }
      changed = true;
    }
  }

  // Save updated queue
  if (changed) {
    await ghPut(
      "queue.json",
      JSON.stringify(queue, null, 2),
      queueSha,
      `TweetDraft: posted ${posted} tweet(s) at ${now.toISOString()}`
    );
    console.log(`Queue updated. Posted: ${posted}`);
  } else {
    console.log("Nothing to post this run.");
  }

  // Append to log (separate commit so queue save doesn't conflict)
  if (newLogEntries.length > 0) {
    await appendToLog(newLogEntries);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

