// TweetDraft — poster.js
// Runs every hour via GitHub Actions
// Reads queue.json, posts any approved tweets whose scheduledTime has passed

const https = require("https");

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

// ── Twitter OAuth 1.0a ────────────────────────────────────────────────────────
const crypto = require("crypto");

function oauthHeader(method, url, params = {}) {
  const enc = (s) => encodeURIComponent(String(s));
  const oauthParams = {
    oauth_consumer_key: process.env.TWITTER_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: process.env.TWITTER_ACCESS_TOKEN,
    oauth_version: "1.0",
  };

  const allParams = { ...oauthParams, ...params };
  const paramStr = Object.keys(allParams)
    .sort()
    .map((k) => `${enc(k)}=${enc(allParams[k])}`)
    .join("&");

  const base = [method.toUpperCase(), enc(url), enc(paramStr)].join("&");
  const sigKey = `${enc(process.env.TWITTER_API_SECRET)}&${enc(process.env.TWITTER_ACCESS_TOKEN_SECRET)}`;
  oauthParams.oauth_signature = crypto
    .createHmac("sha1", sigKey)
    .update(base)
    .digest("base64");

  return (
    "OAuth " +
    Object.keys(oauthParams)
      .sort()
      .map((k) => `${enc(k)}="${enc(oauthParams[k])}"`)
      .join(", ")
  );
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
    const err = JSON.parse(res.body);
    throw new Error(err.detail || err.title || `HTTP ${res.status}`);
  }
  return JSON.parse(res.body);
}

// ── GitHub API — read/write queue.json ───────────────────────────────────────
async function getQueue() {
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
  const res = await request(
    {
      hostname: "api.github.com",
      path: `/repos/${owner}/${repo}/contents/queue.json`,
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        "User-Agent": "TweetDraft",
        Accept: "application/vnd.github+json",
      },
    },
    null
  );

  if (res.status === 404) return null;
  const file = JSON.parse(res.body);
  const content = Buffer.from(file.content, "base64").toString("utf8");
  return { queue: JSON.parse(content), sha: file.sha };
}

async function saveQueue(queue, sha) {
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
  const content = Buffer.from(JSON.stringify(queue, null, 2)).toString("base64");
  const body = JSON.stringify({
    message: `TweetDraft: posted tweet at ${new Date().toISOString()}`,
    content,
    sha,
  });

  const res = await request(
    {
      hostname: "api.github.com",
      path: `/repos/${owner}/${repo}/contents/queue.json`,
      method: "PUT",
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        "User-Agent": "TweetDraft",
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    body
  );

  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Failed to save queue: ${res.status}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date();
  console.log(`Running poster at ${now.toISOString()}`);

  const result = await getQueue();
  if (!result) {
    console.log("No queue.json found — nothing to post.");
    return;
  }

  const { queue, sha } = result;
  let posted = 0;
  let changed = false;

  for (const slot of queue.slots) {
    if (slot.status !== "approved") {
      console.log(`Slot ${slot.id} [${slot.type}]: ${slot.status} — skipping`);
      continue;
    }

    const scheduledAt = new Date(slot.scheduledTime);

    // Post if we're within the scheduled hour window (scheduled time has passed but less than 65 mins ago)
    const minsLate = (now - scheduledAt) / 60000;
    if (minsLate < 0) {
      console.log(`Slot ${slot.id}: scheduled for ${slot.scheduledTime} — not yet`);
      continue;
    }
    if (minsLate > 65) {
      console.log(`Slot ${slot.id}: missed window (${Math.round(minsLate)} mins late) — skipping`);
      continue;
    }

    try {
      console.log(`Posting slot ${slot.id} [${slot.type}]...`);
      await postTweet(slot.text);
      slot.status = "posted";
      slot.postedAt = now.toISOString();
      posted++;
      changed = true;
      console.log(`✓ Posted: "${slot.text.substring(0, 60)}..."`);

      // Small delay between tweets if posting multiple in same run
      if (posted > 1) await new Promise((r) => setTimeout(r, 2000));
    } catch (e) {
      console.error(`✗ Failed to post slot ${slot.id}: ${e.message}`);
      slot.status = "failed";
      slot.error = e.message;
      changed = true;
    }
  }

  if (changed) {
    await saveQueue(queue, sha);
    console.log(`Queue updated. Posted: ${posted}`);
  } else {
    console.log("Nothing to post this run.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
