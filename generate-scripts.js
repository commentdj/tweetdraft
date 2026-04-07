// ScriptBuilder — generate-scripts.js
// Triggered manually via GitHub Actions workflow_dispatch
// Calls Anthropic API, writes scripts.json to repo

const https = require("https");

const PERSONA = `You are a world-class short-form video scriptwriter ghostwriting for a startup founder who validates business ideas.

VOICE & STYLE:
- Direct, founder-native, honest. No fluff, no corporate speak.
- Short punchy sentences. Rhetorical questions. Create tension then resolve.
- Sound like a real person who has been in the trenches, not a polished presenter.
- Ground everything in specifics and real examples.

TONE VARIETY — generate exactly these quantities:
- Challenging (12): Provocative angles, challenge assumptions, make the viewer uncomfortable then enlighten them
- Informative (12): Educational, numbered lists, how-tos, specific and actionable
- Exciting (8): High energy, big reveals, strong hooks, momentum throughout
- Off-the-cuff (8): Casual, thinking out loud, raw and honest, imperfect on purpose
- Story-driven (5): Mini narrative with a lesson, setup/conflict/resolution
- Spiky-take (5): Contrarian opinion, hot take, debate-starting

RULES:
- No emojis
- Never start with "I just"
- No motivational fluff
- Each script 60-200 words (30-90 seconds when spoken)
- Sound like a real person, not performing for an audience
- Vary the hooks — do not use the same opening style twice in a row

HOOK LIBRARY — use these as inspiration, vary them across scripts:
1. Nobody talks about this but...
2. I made [result] in [timeframe] by doing one thing...
3. Stop doing [X] if you want [Y]
4. The reason you're not getting [result] is...
5. I tried [X] for 30 days — here's what happened
6. This is the biggest mistake I see founders making
7. What I wish I knew before starting [X]
8. The truth about [X] that nobody tells you
9. How I went from [X] to [Y] — the real story
10. Why [common advice] doesn't work (and what does)
11. The counterintuitive way to [achieve result]
12. If I had to start over, I'd do this first
13. You're thinking about [X] completely wrong
14. Every founder needs to hear this right now
15. This one thing changed everything for me

CONTENT DIRECTION:
Core topics: startup validation, building with AI, founder mindset, idea testing, removing friction from business.
Target audience: early-stage founders, aspiring entrepreneurs validating ideas.
Avoid: generic hustle content, vague inspiration, anything that sounds like a course ad.`;

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

const GH_TOKEN = process.env.GITHUB_TOKEN;
const [OWNER, REPO] = (process.env.GITHUB_REPOSITORY || "/").split("/");

async function ghGet(path) {
  const res = await httpRequest({
    hostname: "api.github.com",
    path: `/repos/${OWNER}/${REPO}/contents/${path}`,
    method: "GET",
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      "User-Agent": "ScriptBuilder",
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
      "User-Agent": "ScriptBuilder",
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

async function generateBatch(prompt, batchNum) {
  console.log(`  Calling Anthropic API (batch ${batchNum})...`);
  const reqBody = JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
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

  if (res.status !== 200) throw new Error(`Anthropic API error: ${res.status} — ${res.body}`);
  const d = JSON.parse(res.body);
  const text = d.content?.[0]?.text || "";
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("[");
  const end = clean.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error(`No JSON array in batch ${batchNum} response`);
  return JSON.parse(clean.slice(start, end + 1));
}

async function generateYouTube() {
  console.log("  Generating YouTube scripts...");
  const prompt = `You are writing YouTube video scripts for a startup founder who validates business ideas.

Generate 2 YouTube video outlines for 15-minute videos.

For each provide:
- title: SEO-optimised, under 70 chars, creates curiosity
- description: 150 words, keyword-rich, includes [TIMESTAMPS] placeholder
- script: Full structured outline with: Hook (first 30 seconds to grab attention), 4-5 main sections each with key talking points and specific examples, CTA outro

The content should be meaty, specific, and based on real founder experience. Not generic.

Topics to choose from: idea validation frameworks, AI tools for founders, why most startups fail at validation, how to find your first 10 customers, building in public, pricing your first product.

Return ONLY a JSON array:
[{"id":1,"type":"youtube_15min","title":"...","description":"...","script":"..."}]`;

  const reqBody = JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 3000,
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
  if (res.status !== 200) throw new Error(`YouTube API error: ${res.status}`);
  const d = JSON.parse(res.body);
  const text = d.content?.[0]?.text || "";
  const clean = text.replace(/```json|```/g, "").trim();
  const s = clean.indexOf("["), e = clean.lastIndexOf("]");
  if (s === -1) return [];
  return JSON.parse(clean.slice(s, e + 1));
}

async function generateSpitball() {
  console.log("  Generating spitball guide...");
  const prompt = `Create a 30-minute spitball session guide for a startup founder/creator.

The founder validates business ideas and builds with AI. They want to record a casual, thinking-out-loud video where they work through a meaty topic.

Provide:
- title: Compelling, under 70 chars
- description: 100 words for YouTube
- script: Full guide including:
  * Opening hook question to start with (30 seconds)
  * 8-10 meaty discussion prompts — each meaty enough for 2-3 minutes of honest thinking out loud
  * Key tensions or contradictions to explore
  * Stories or examples to pull from
  * Suggested ending/takeaway

Make it genuinely interesting — not generic startup content.

Return ONLY a JSON object:
{"type":"spitball_30min","title":"...","description":"...","script":"..."}`;

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
  if (res.status !== 200) throw new Error(`Spitball API error: ${res.status}`);
  const d = JSON.parse(res.body);
  const text = d.content?.[0]?.text || "";
  const clean = text.replace(/```json|```/g, "").trim();
  const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
  if (s === -1) return null;
  return JSON.parse(clean.slice(s, e + 1));
}

async function main() {
  console.log("=== ScriptBuilder Generate ===");
  console.log("Repo:", process.env.GITHUB_REPOSITORY);

  // Extra ideas from workflow input
  const extraIdeas = process.env.EXTRA_IDEAS || "";
  const campaignHooks = process.env.CAMPAIGN_HOOKS || "";
  const extraContext = (campaignHooks ? `\nCAMPAIGN HOOKS THIS WEEK:\n${campaignHooks}` : "") +
                       (extraIdeas ? `\nADDITIONAL IDEAS:\n${extraIdeas}` : "");

  // Generate short-form in 3 batches of ~17 to avoid timeouts
  const batches = [
    { tones: "- Challenging: 4 scripts\n- Informative: 4 scripts\n- Exciting: 3 scripts\n- Off-the-cuff: 3 scripts\n- Story-driven: 2 scripts\n- Spiky-take: 1 script", num: 1 },
    { tones: "- Challenging: 4 scripts\n- Informative: 4 scripts\n- Exciting: 3 scripts\n- Off-the-cuff: 3 scripts\n- Story-driven: 2 scripts\n- Spiky-take: 1 script", num: 2 },
    { tones: "- Challenging: 4 scripts\n- Informative: 4 scripts\n- Exciting: 2 scripts\n- Off-the-cuff: 2 scripts\n- Story-driven: 1 script\n- Spiky-take: 3 scripts", num: 3 },
  ];

  let allScripts = [];

  for (const batch of batches) {
    const prompt = PERSONA + extraContext +
      `\n\nGenerate short-form video scripts for this batch.\n\nTONE MIX FOR THIS BATCH:\n${batch.tones}\n\nIMPORTANT: Make each script completely different topic and angle. No repetition.\n\nReturn ONLY a JSON array:\n[{"id":1,"title":"Video title under 60 chars","tone":"Challenging","hook":"Opening line of script","hookType":"challenge","script":"Full script text here...","description":"2 sentence posting description","wordCount":120,"estimatedSeconds":48}]`;

    console.log(`\n[Batch ${batch.num}/3] Generating...`);
    const scripts = await generateBatch(prompt, batch.num);
    scripts.forEach((s, i) => { s.id = allScripts.length + i + 1; s.status = "pending"; });
    allScripts = allScripts.concat(scripts);
    console.log(`  Got ${scripts.length} scripts. Total: ${allScripts.length}`);

    if (batch.num < 3) {
      console.log("  Pausing 2s between batches...");
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`\n[YouTube] Generating 2 YouTube scripts...`);
  const youtube = await generateYouTube();
  console.log(`  Got ${youtube.length} YouTube scripts`);

  console.log(`\n[Spitball] Generating 30-min guide...`);
  const spitball = await generateSpitball();
  console.log(`  Spitball: ${spitball?.title || 'none'}`);

  // Write scripts.json to repo
  const output = {
    generatedAt: new Date().toISOString(),
    totalScripts: allScripts.length,
    shortForm: allScripts,
    youtube: youtube,
    spitball: spitball,
  };

  console.log("\nWriting scripts.json to repo...");
  const existing = await ghGet("scripts.json").catch(() => null);
  const sha = existing ? existing.sha : undefined;
  await ghPut("scripts.json", JSON.stringify(output, null, 2), sha, `ScriptBuilder: generated ${allScripts.length} scripts at ${new Date().toISOString()}`);

  console.log(`\n✓ Done. ${allScripts.length} short-form + ${youtube.length} YouTube + 1 spitball written to scripts.json`);
}

main().catch(err => {
  console.error("FATAL ERROR:", err.message);
  process.exit(1);
});
