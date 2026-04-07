// ScriptBuilder generate-scripts.js
// Reads pending-batch.json, generates 50 scripts, writes batch-N.json

var https = require('https');

var GH_TOKEN = process.env.GITHUB_TOKEN;
var REPO = process.env.GITHUB_REPOSITORY || 'commentdj/tweetdraft';
var OWNER = REPO.split('/')[0];
var REPONAME = REPO.split('/')[1];
var ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

function ghRequest(method, path, body, cb) {
  var bodyStr = body ? JSON.stringify(body) : null;
  var opts = {
    hostname: 'api.github.com',
    path: '/repos/' + OWNER + '/' + REPONAME + '/contents/' + path,
    method: method,
    headers: {
      'Authorization': 'Bearer ' + GH_TOKEN,
      'User-Agent': 'ScriptBuilder',
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    }
  };
  if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
  var req = https.request(opts, function(res) {
    var data = '';
    res.on('data', function(c) { data += c; });
    res.on('end', function() { cb(null, res.statusCode, data); });
  });
  req.on('error', cb);
  if (bodyStr) req.write(bodyStr);
  req.end();
}

function ghGet(path, cb) {
  ghRequest('GET', path, null, function(err, status, data) {
    if (err) return cb(err);
    if (status === 404) return cb(null, null, null);
    if (status !== 200) return cb(new Error('ghGet ' + path + ' failed: ' + status));
    var file = JSON.parse(data);
    var content = Buffer.from(file.content.replace(/\n/g, ''), 'base64').toString('utf8');
    cb(null, JSON.parse(content), file.sha);
  });
}

function ghPut(path, content, sha, message, cb) {
  var encoded = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');
  var payload = { message: message, content: encoded };
  if (sha) payload.sha = sha;
  ghRequest('PUT', path, payload, function(err, status, data) {
    if (err) return cb(err);
    if (status !== 200 && status !== 201) return cb(new Error('ghPut failed: ' + status + ' ' + data));
    cb(null);
  });
}

function anthropicCall(prompt, maxTokens, cb) {
  var body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens || 4000,
    messages: [{ role: 'user', content: prompt }]
  });
  var opts = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(body)
    }
  };
  var req = https.request(opts, function(res) {
    var data = '';
    res.on('data', function(c) { data += c; });
    res.on('end', function() {
      if (res.statusCode !== 200) return cb(new Error('Anthropic error ' + res.statusCode + ': ' + data));
      var parsed = JSON.parse(data);
      var text = (parsed.content || []).map(function(b) { return b.text || ''; }).join('');
      var clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
      var start = clean.indexOf('[');
      var end = clean.lastIndexOf(']');
      if (start === -1) { start = clean.indexOf('{'); end = clean.lastIndexOf('}'); }
      if (start === -1 || end === -1) return cb(new Error('No JSON in response. Raw: ' + text.substring(0, 200)));
      try {
        cb(null, JSON.parse(clean.slice(start, end + 1)));
      } catch(e) {
        cb(new Error('JSON parse error: ' + e.message + ' Raw: ' + clean.substring(0, 200)));
      }
    });
  });
  req.on('error', cb);
  req.write(body);
  req.end();
}

function buildPrompt(batch, toneSpec, batchNum, totalBatches) {
  var settings = batch.settings || {};
  var voice = settings.toneOfVoice || 'Direct, founder-native, honest. No fluff. Short punchy sentences. Real examples.';
  var themes = settings.generalThemes || 'Startup validation, building with AI, founder mindset, idea testing.';
  var hooks = settings.hooks || '';
  var exampleScripts = settings.exampleScripts || '';
  var ideasThisWeek = batch.ideasThisWeek || '';
  var newHooks = batch.newHooks || '';
  var transcripts = batch.transcripts || '';

  var p = 'You are a short-form video scriptwriter. Write in this exact voice:\n\n';
  p += 'VOICE AND TONE:\n' + voice + '\n\n';
  p += 'GENERAL THEMES:\n' + themes + '\n\n';
  if (hooks) p += 'PROVEN HOOKS TO USE:\n' + hooks + '\n\n';
  if (exampleScripts) p += 'EXAMPLE SCRIPTS (match this style):\n' + exampleScripts + '\n\n';
  if (ideasThisWeek) p += 'IDEAS THIS WEEK:\n' + ideasThisWeek + '\n\n';
  if (newHooks) p += 'NEW HOOKS TO TRY:\n' + newHooks + '\n\n';
  if (transcripts) p += 'TIKTOK TRANSCRIPTS TO REWRITE IN MY VOICE (pick the best ideas, completely reword):\n' + transcripts + '\n\n';
  p += 'GENERATE THIS BATCH (batch ' + batchNum + ' of ' + totalBatches + '):\n' + toneSpec + '\n\n';
  p += 'RULES:\n';
  p += '- No emojis\n';
  p += '- Never start with I just\n';
  p += '- No motivational fluff\n';
  p += '- 60-200 words per script (30-90 seconds spoken)\n';
  p += '- Every script must be a completely different topic and angle\n';
  p += '- Sound like a real person not performing for an audience\n\n';
  p += 'Return ONLY a valid JSON array. No explanation. No markdown:\n';
  p += '[{"title":"Short video title under 60 chars","tone":"Challenging","hook":"Opening line","script":"Full script text","description":"2 sentence posting description","estimatedSeconds":45}]';
  return p;
}

function main() {
  console.log('ScriptBuilder starting...');
  console.log('Repo:', REPO);
  console.log('Anthropic key present:', !!ANTHROPIC_KEY);

  if (!ANTHROPIC_KEY) { console.error('ERROR: ANTHROPIC_API_KEY secret not set'); process.exit(1); }

  ghGet('pending-batch.json', function(err, batch, batchSha) {
    if (err) { console.error('ERROR reading pending-batch.json:', err.message); process.exit(1); }
    if (!batch) { console.error('ERROR: No pending-batch.json found in repo'); process.exit(1); }

    console.log('Batch:', batch.batchNumber, '| Ideas:', !!(batch.ideasThisWeek), '| Transcripts:', !!(batch.transcripts));

    // 3 batches: ~17 scripts each, total ~50
    var batches = [
      'Tone mix for this batch:\n- Challenging: 5 scripts\n- Informative: 4 scripts\n- Exciting: 3 scripts\n- Off-the-cuff: 3 scripts\n- Story-driven: 2 scripts',
      'Tone mix for this batch:\n- Challenging: 5 scripts\n- Informative: 4 scripts\n- Exciting: 3 scripts\n- Off-the-cuff: 2 scripts\n- Story-driven: 2 scripts\n- Spiky: 1 script',
      'Tone mix for this batch:\n- Challenging: 4 scripts\n- Informative: 4 scripts\n- Exciting: 2 scripts\n- Off-the-cuff: 3 scripts\n- Spiky: 4 scripts'
    ];

    var allScripts = [];
    var idx = 0;

    function runBatch() {
      if (idx >= batches.length) return finish();
      var batchNum = idx + 1;
      console.log('Generating batch ' + batchNum + ' of ' + batches.length + '...');
      var prompt = buildPrompt(batch, batches[idx], batchNum, batches.length);
      anthropicCall(prompt, 4000, function(err, scripts) {
        if (err) { console.error('ERROR in batch ' + batchNum + ':', err.message); process.exit(1); }
        if (!Array.isArray(scripts)) { console.error('ERROR: Not an array in batch ' + batchNum); process.exit(1); }
        scripts.forEach(function(s, i) {
          s.id = allScripts.length + i + 1;
          s.status = 'pending';
          s.batchNum = batchNum;
        });
        allScripts = allScripts.concat(scripts);
        console.log('Batch ' + batchNum + ' done: ' + scripts.length + ' scripts. Total: ' + allScripts.length);
        idx++;
        setTimeout(runBatch, 1500);
      });
    }

    function finish() {
      console.log('All batches done. Total scripts: ' + allScripts.length);
      var result = {
        batchNumber: batch.batchNumber,
        generatedAt: new Date().toISOString(),
        ideasThisWeek: batch.ideasThisWeek,
        newHooks: batch.newHooks,
        tiktokUrls: batch.tiktokUrls,
        scripts: allScripts
      };

      var filename = 'batch-' + batch.batchNumber + '.json';
      console.log('Writing', filename, '...');
      ghPut(filename, result, null, 'ScriptBuilder: batch ' + batch.batchNumber + ' - ' + allScripts.length + ' scripts', function(err) {
        if (err) { console.error('ERROR writing', filename, ':', err.message); process.exit(1); }
        console.log('Done!', filename, 'written with', allScripts.length, 'scripts.');
      });
    }

    runBatch();
  });
}

main();
