#!/usr/bin/env python3
"""
VideoAgent Pipeline
===================
Processes raw footage from Google Drive, edits with ffmpeg,
schedules via Buffer, updates ScriptBuilder on GitHub.

Usage:
  python pipeline.py          - Normal run (process new files)
  python pipeline.py --test   - Test mode (checks connections, no changes)
  python pipeline.py --one    - Process one file only (safe first run)
"""

import os, sys, json, json, re, subprocess, tempfile, shutil, time, traceback
from pathlib import Path
from datetime import datetime, timedelta
import requests
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

# ── Args ──────────────────────────────────────────────────────────────────────
TEST_MODE   = "--test"      in sys.argv
ONE_ONLY    = "--one"       in sys.argv
REPROCESS   = "--reprocess" in sys.argv  # Clear processed log for a specific file

# ── Load config ───────────────────────────────────────────────────────────────
BASE = Path(__file__).parent
CONFIG_FILE = BASE / "config.json"

if not CONFIG_FILE.exists():
    print("ERROR: config.json not found in", BASE)
    sys.exit(1)

cfg = json.loads(CONFIG_FILE.read_text())

ZERNIO_TOKEN      = cfg.get("zernio_token", "")
GH_REPO           = cfg.get("github_repo", "")
GH_TOKEN          = cfg.get("github_token", "")
RAW_FOLDER_ID     = cfg.get("raw_footage_folder_id", "")
EDITED_FOLDER_ID  = cfg.get("edited_folder_id", "")
CREDENTIALS_JSON  = BASE / cfg.get("credentials_json", "credentials.json")

# Debug: show exactly where we are looking
if not CREDENTIALS_JSON.exists():
    # Try current working directory as fallback
    cwd_creds = Path.cwd() / cfg.get("credentials_json", "credentials.json")
    if cwd_creds.exists():
        CREDENTIALS_JSON = cwd_creds
POST_TIMES        = cfg.get("post_times", ["09:00","12:00","17:00","20:00"])
PLATFORMS         = cfg.get("platforms", ["tiktok","instagram","youtube"])
WHISPER_MODEL     = cfg.get("whisper_model", "base")
SILENCE_THRESH_S  = cfg.get("silence_threshold_seconds", 0.6)
SILENCE_DB        = cfg.get("min_silence_db", -40)
TITLE_SECS        = cfg.get("title_card_seconds", 3)
TITLE_FONT_SIZE   = cfg.get("title_font_size", 48)
CAPTIONS_ENABLED  = cfg.get("captions_enabled", True)
NOTIFY_EMAIL      = cfg.get("notify_email", "")
SMTP_USER         = cfg.get("smtp_user", "")
SMTP_PASS         = cfg.get("smtp_password", "")
SMTP_HOST         = cfg.get("smtp_host", "smtp.gmail.com")
SMTP_PORT         = cfg.get("smtp_port", 587)

# ── Logging ───────────────────────────────────────────────────────────────────
LOG_FILE = BASE / "pipeline.log"
log_lines = []

def log(msg, level="INFO"):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] [{level}] {msg}"
    print(line)
    log_lines.append(line)
    # Append to log file
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def log_ok(msg):  log(f"✓ {msg}", "OK")
def log_err(msg): log(f"✗ {msg}", "ERROR")
def log_warn(msg):log(f"! {msg}", "WARN")

# ── Email reporting ───────────────────────────────────────────────────────────
def send_report(subject, body, is_error=False):
    if not NOTIFY_EMAIL or not SMTP_USER or not SMTP_PASS:
        return
    try:
        msg = MIMEMultipart()
        msg["From"] = SMTP_USER
        msg["To"] = NOTIFY_EMAIL
        msg["Subject"] = f"VideoAgent: {subject}"
        msg.attach(MIMEText(body, "plain"))
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
            server.starttls()
            server.login(SMTP_USER, SMTP_PASS)
            server.sendmail(SMTP_USER, NOTIFY_EMAIL, msg.as_string())
        log_ok(f"Report emailed to {NOTIFY_EMAIL}")
    except Exception as e:
        log_warn(f"Could not send email: {e}")

# ── Startup ───────────────────────────────────────────────────────────────────
log("=" * 55)
if TEST_MODE:
    log("VideoAgent — TEST MODE (no changes will be made)")
elif ONE_ONLY:
    log("VideoAgent — ONE FILE MODE")
else:
    log("VideoAgent — Normal Run")
log("=" * 55)

# ── Check config values ───────────────────────────────────────────────────────
log("Checking configuration...")
config_ok = True

checks = [
    (ZERNIO_TOKEN and ZERNIO_TOKEN != "PASTE_YOUR_ZERNIO_TOKEN_HERE", "Buffer token"),
    (GH_TOKEN and GH_TOKEN != "PASTE_YOUR_GITHUB_TOKEN_HERE", "GitHub token"),
    (GH_REPO, "GitHub repo"),
    (RAW_FOLDER_ID, "Raw footage folder ID"),
    (EDITED_FOLDER_ID, "Edited folder ID"),
    (CREDENTIALS_JSON.exists(), f"credentials.json (looking in: {CREDENTIALS_JSON})"),
]

for ok, name in checks:
    if ok:
        log_ok(name)
    else:
        log_err(f"{name} not configured — edit config.json")
        config_ok = False

if not config_ok:
    log_err("Fix config.json errors above then run again")
    sys.exit(1)

# ── Check dependencies ────────────────────────────────────────────────────────
log("Checking dependencies...")

def check_cmd(cmd, name):
    try:
        subprocess.run(cmd, capture_output=True, check=True)
        log_ok(name)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        log_err(f"{name} not found — check installation")
        return False

deps_ok = True
deps_ok &= check_cmd(["ffmpeg", "-version"], "ffmpeg")

try:
    import whisper
    log_ok("Whisper")
except ImportError:
    log_err("Whisper not installed — run: pip install openai-whisper")
    deps_ok = False

try:
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaFileUpload, MediaIoBaseDownload
    log_ok("Google API libraries")
except ImportError:
    log_err("Google API missing — run: pip install google-auth google-auth-oauthlib google-api-python-client")
    deps_ok = False

try:
    from fuzzywuzzy import fuzz
    log_ok("FuzzyWuzzy")
except ImportError:
    log_err("FuzzyWuzzy missing — run: pip install fuzzywuzzy python-levenshtein")
    deps_ok = False

if not deps_ok:
    sys.exit(1)

# ── Google Drive connection ───────────────────────────────────────────────────
SCOPES = ["https://www.googleapis.com/auth/drive"]
TOKEN_FILE = BASE / "token.json"

def get_drive_service():
    creds = None
    if TOKEN_FILE.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_JSON), SCOPES)
            creds = flow.run_local_server(port=0)
        TOKEN_FILE.write_text(creds.to_json())
    return build("drive", "v3", credentials=creds)

log("Connecting to Google Drive...")
try:
    drive = get_drive_service()
    # Test by listing the raw footage folder
    test = drive.files().list(
        q=f"'{RAW_FOLDER_ID}' in parents and trashed=false",
        fields="files(id,name)", pageSize=1
    ).execute()
    log_ok("Google Drive connected")
except Exception as e:
    log_err(f"Google Drive connection failed: {e}")
    sys.exit(1)

# ── Zernio connection test ────────────────────────────────────────────────────
log("Checking Zernio connection...")
_ZB = "https://zernio.com/api/v1"
_ZH = {"Authorization": f"Bearer {ZERNIO_TOKEN}", "Content-Type": "application/json"}
try:
    r = requests.get(f"{_ZB}/accounts", headers=_ZH, timeout=10)
    if r.status_code == 200:
        data = r.json()
        accs = data if isinstance(data, list) else data.get("accounts", data.get("data", []))
        names = [f"{a.get('name','?')} ({a.get('platform','?')})" for a in accs[:5]]
        log_ok(f"Zernio connected — {len(accs)} account(s): {', '.join(names)}")
    else:
        log_warn(f"Zernio returned {r.status_code} — scheduling skipped, processing continues")
except Exception as e:
    log_warn(f"Zernio check failed: {e} — scheduling skipped, processing continues")

# ── GitHub connection test ────────────────────────────────────────────────────
log("Checking GitHub connection...")
GH_HEADERS = {
    "Authorization": f"Bearer {GH_TOKEN}",
    "Accept": "application/vnd.github+json",
    "User-Agent": "VideoAgent"
}
try:
    r = requests.get(f"https://api.github.com/repos/{GH_REPO}", headers=GH_HEADERS, timeout=10)
    if r.status_code == 200:
        log_ok(f"GitHub connected — repo: {GH_REPO}")
    else:
        log_warn(f"GitHub returned {r.status_code}")
except Exception as e:
    log_warn(f"GitHub check failed: {e}")

# ── TEST MODE EXIT ────────────────────────────────────────────────────────────
if TEST_MODE:
    log("")
    log("TEST MODE COMPLETE — all connections checked")
    log("Run without --test to process real videos")
    log("")

    # Show what would be processed
    log("Scanning for raw footage...")
    results = drive.files().list(
        q=f"'{RAW_FOLDER_ID}' in parents and mimeType contains 'video/' and trashed=false",
        fields="files(id,name,size)"
    ).execute()
    raw_files = results.get("files", [])
    log(f"Found {len(raw_files)} video file(s) in Raw Footage folder:")
    for f in raw_files:
        size_mb = int(f.get("size",0))/1024/1024
        log(f"  - {f['name']} ({size_mb:.1f} MB)")

    log("")
    log("Loading scripts from GitHub...")
    recorded_count = 0
    for i in range(1, 10):
        r = requests.get(
            f"https://api.github.com/repos/{GH_REPO}/contents/batch-{i}.json",
            headers=GH_HEADERS
        )
        if r.status_code == 404:
            break
        if r.status_code == 200:
            import base64
            data = json.loads(base64.b64decode(r.json()["content"].replace("\n","")).decode())
            batch_recorded = [s for s in data.get("scripts",[]) if s.get("status")=="recorded"]
            recorded_count += len(batch_recorded)
            if batch_recorded:
                log(f"  batch-{i}.json: {len(batch_recorded)} recorded scripts ready to match")

    log(f"Total recorded scripts: {recorded_count}")
    log("")
    if raw_files and recorded_count > 0:
        log("READY: Run 'python pipeline.py' to process videos")
    elif not raw_files:
        log("WAITING: Upload raw .mp4 files to your Raw Footage Drive folder")
    elif recorded_count == 0:
        log("WAITING: Mark scripts as recorded in ScriptBuilder")
    sys.exit(0)

# ── Load processed log ────────────────────────────────────────────────────────
PROCESSED_LOG = BASE / "processed.json"
processed_log = {}
if PROCESSED_LOG.exists():
    try:
        processed_log = json.loads(PROCESSED_LOG.read_text())
    except:
        processed_log = {}

# ── Reprocess mode ────────────────────────────────────────────────────────────
if REPROCESS:
    log("REPROCESS MODE — resetting everything and reprocessing now")
    log("")

    # 1. Clear the processed files log
    if processed_log:
        log(f"Clearing processed log ({len(processed_log)} file(s))...")
        for fid, info in processed_log.items():
            log(f"  - {info.get('file_name','?')}")
    processed_log = {}
    PROCESSED_LOG.write_text(json.dumps({}))
    log_ok("Processed log cleared")

    # 2. Reset 'scheduled' scripts back to 'recorded' in GitHub
    # so the pipeline can match them again
    log("Resetting script statuses in GitHub...")
    try:
        import base64 as _b64
        for batch_num in range(1, 51):
            r = requests.get(
                f"https://api.github.com/repos/{GH_REPO}/contents/batch-{batch_num}.json",
                headers=GH_HEADERS, timeout=10
            )
            if r.status_code == 404:
                break
            if r.status_code != 200:
                continue
            d = r.json()
            content = json.loads(_b64.b64decode(d["content"].replace("\n","")).decode())
            sha = d["sha"]
            changed = False
            for s in content.get("scripts", []):
                if s.get("status") == "scheduled":
                    s["status"] = "recorded"
                    s.pop("scheduledAt", None)
                    s.pop("driveLink", None)
                    changed = True
            if changed:
                encoded = _b64.b64encode(json.dumps(content, indent=2).encode()).decode()
                requests.put(
                    f"https://api.github.com/repos/{GH_REPO}/contents/batch-{batch_num}.json",
                    headers=GH_HEADERS,
                    json={"message": "VideoAgent: reset scheduled -> recorded for reprocess", "content": encoded, "sha": sha},
                    timeout=15
                )
                log_ok(f"batch-{batch_num}.json: reset scheduled scripts to recorded")
    except Exception as e:
        log_warn(f"Could not reset script statuses: {e}")

    log("")
    log("Reset complete — continuing to process videos now...")
    log("")
    # Do NOT exit — fall through to normal processing

# ── Scan Raw Footage folder ───────────────────────────────────────────────────
log("Scanning Raw Footage folder...")
results = drive.files().list(
    q=f"'{RAW_FOLDER_ID}' in parents and mimeType contains 'video/' and trashed=false",
    fields="files(id,name,size)"
).execute()
all_raw = results.get("files", [])
raw_files = [f for f in all_raw if f["id"] not in processed_log]

log(f"Found {len(all_raw)} total video(s), {len(raw_files)} new to process")

if not raw_files:
    log("Nothing new to process. Exiting.")
    sys.exit(0)

if ONE_ONLY:
    log("ONE FILE MODE — processing first file only")
    raw_files = raw_files[:1]

# ── Load scripts from GitHub ──────────────────────────────────────────────────
log("Loading recorded scripts from GitHub...")
all_scripts = []
batch_data = {}
batch_shas = {}

def gh_get_file(path):
    import base64
    try:
        r = requests.get(
            f"https://api.github.com/repos/{GH_REPO}/contents/{path}",
            headers=GH_HEADERS,
            timeout=10
        )
        if r.status_code == 404:
            return None, None
        r.raise_for_status()
        d = r.json()
        content = json.loads(base64.b64decode(d["content"].replace("\n","")).decode())
        return content, d["sha"]
    except Exception as e:
        log_warn(f"gh_get_file {path} failed: {e}")
        return None, None

def gh_put_file(path, content, sha, message):
    import base64
    encoded = base64.b64encode(json.dumps(content, indent=2).encode()).decode()
    payload = {"message": message, "content": encoded}
    if sha:
        payload["sha"] = sha
    r = requests.put(
        f"https://api.github.com/repos/{GH_REPO}/contents/{path}",
        headers=GH_HEADERS, json=payload
    )
    r.raise_for_status()

for batch_num in range(1, 51):
    data, sha = gh_get_file(f"batch-{batch_num}.json")
    if not data:
        break
    batch_data[batch_num] = data
    batch_shas[batch_num] = sha

    # Also load approvals file — ScriptBuilder saves recorded status here
    approvals_data, _ = gh_get_file(f"approvals-batch-{batch_num}.json")
    approval_statuses = {}
    if approvals_data and approvals_data.get("approvals"):
        approval_statuses = approvals_data["approvals"]

    for idx, s in enumerate(data.get("scripts", [])):
        # Check both the script status AND the approvals file
        script_status = s.get("status", "pending")
        approval_status = approval_statuses.get(str(idx), "")
        effective_status = approval_status if approval_status else script_status

        if effective_status == "recorded":
            s["status"] = "recorded"
            s["_batch"] = batch_num
            s["_idx"] = idx
            all_scripts.append(s)
            log(f"  Found recorded script: '{s.get('title','?')}' (batch {batch_num}, idx {idx})")
        elif s.get("status") is None:
            s["status"] = "pending"  # Fix None statuses

log(f"Found {len(all_scripts)} recorded scripts across {len(batch_data)} batches")
if len(all_scripts) == 0:
    # Show what statuses exist to help debug
    all_statuses = {}
    for bn, bd in batch_data.items():
        for s in bd.get("scripts",[]):
            st = str(s.get("status","None"))
            all_statuses[st] = all_statuses.get(st,0) + 1
    log(f"  Script statuses found: {all_statuses}")

if not all_scripts:
    log_warn("No scripts marked as 'recorded' in ScriptBuilder")
    log_warn("Mark scripts as Done in the Record tab first")
    sys.exit(0)

# ── Load Whisper ──────────────────────────────────────────────────────────────
log(f"Loading Whisper ({WHISPER_MODEL} model)...")
model = whisper.load_model(WHISPER_MODEL)
log_ok("Whisper ready")

# ── Helpers ───────────────────────────────────────────────────────────────────
def download_from_drive(file_id, file_name, dest):
    import io
    request = drive.files().get_media(fileId=file_id)
    fh = io.FileIO(str(dest), "wb")
    downloader = MediaIoBaseDownload(fh, request)
    done = False
    while not done:
        status, done = downloader.next_chunk()
        if status:
            pct = int(status.progress() * 100)
            print(f"    Downloading {file_name}... {pct}%", end="\r")
    print(f"    Downloaded {file_name}                      ")

def upload_to_drive(file_path, folder_id, file_name):
    media = MediaFileUpload(str(file_path), mimetype="video/mp4", resumable=True)
    meta = {"name": file_name, "parents": [folder_id]}
    uploaded = drive.files().create(body=meta, media_body=media, fields="id,webViewLink").execute()
    return uploaded.get("id"), uploaded.get("webViewLink")

def match_script(transcription_text, scripts):
    clean_trans = re.sub(r"[^\w\s]", "", transcription_text.lower())
    best_score, best_script = 0, None
    for s in scripts:
        clean_script = re.sub(r"[^\w\s]", "", s.get("script","").lower())
        score = fuzz.token_set_ratio(clean_trans, clean_script)
        if score > best_score:
            best_score = score
            best_script = s
    return best_script, best_score

def get_video_duration(path):
    """Get video duration in seconds using ffprobe."""
    cmd = ["ffprobe","-v","quiet","-print_format","json","-show_streams",str(path)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        return None
    try:
        data = json.loads(r.stdout)
        for stream in data.get("streams",[]):
            if stream.get("duration"):
                return float(stream["duration"])
    except:
        pass
    return None

def normalise_text(text):
    """Strip punctuation and lowercase for comparison."""
    import re
    return re.sub(r"[^a-z0-9 ]", "", text.lower()).strip()

def find_false_starts(words, script_text=None, min_phrase_len=2, similarity_thresh=0.70):
    """
    Detect false starts and repeated takes.
    
    Example: 
      "The idea"  <- false start (remove)
      "The idea you think"  <- false start (remove)  
      "The idea you think needs more research"  <- keep (longest/last complete take)
    
    Returns set of word indices to REMOVE.
    """
    if not words:
        return set()

    # Group words into chunks separated by pauses >= 0.35s
    chunks = []
    chunk_words = [0]
    for i in range(1, len(words)):
        gap = words[i]["start"] - words[i-1]["end"]
        if gap >= 0.35:
            chunks.append(chunk_words[:])
            chunk_words = [i]
        else:
            chunk_words.append(i)
    if chunk_words:
        chunks.append(chunk_words)

    remove_indices = set()
    n = len(chunks)

    for i in range(n):
        if any(idx in remove_indices for idx in chunks[i]):
            continue  # Already marked, skip

        chunk_a = chunks[i]
        a_words = [normalise_text(words[j]["word"]) for j in chunk_a]
        if not a_words:
            continue

        # Look at all later chunks to see if any starts the same way
        for j in range(i + 1, n):
            chunk_b = chunks[j]
            b_words = [normalise_text(words[k]["word"]) for k in chunk_b]
            if not b_words:
                continue

            # How many words does A share with the START of B?
            compare_len = min(len(a_words), len(b_words))
            if compare_len < min_phrase_len:
                continue

            matching = sum(1 for x, y in zip(a_words, b_words) if x == y)
            # A is a false start of B if:
            # 1. A's words match the beginning of B at high rate, AND
            # 2. B is longer (more complete) than A
            match_ratio = matching / len(a_words)

            if match_ratio >= similarity_thresh and len(b_words) > len(a_words):
                # A is a partial/false start of B — remove A
                for idx in chunk_a:
                    remove_indices.add(idx)
                log(f"    False start removed: '{' '.join(a_words[:6])}...' (superseded by longer take)")
                break

            # Also catch near-identical full repeats (same length, same words)
            # e.g. presenter says the same line twice perfectly
            if len(a_words) >= 6 and len(b_words) >= 6:
                full_match = sum(1 for x, y in zip(a_words, b_words) if x == y)
                full_ratio = full_match / max(len(a_words), len(b_words))
                if full_ratio >= 0.80:
                    # Nearly identical take — keep the later one (B), remove earlier (A)
                    for idx in chunk_a:
                        remove_indices.add(idx)
                    log(f"    Duplicate take removed: '{' '.join(a_words[:6])}...'")
                    break

    # Cross-reference with script: remove chunks that are short AND
    # start the same way as a later chunk AND don't form a complete script sentence
    if script_text:
        script_n = normalise_text(script_text)
        for i, chunk in enumerate(chunks):
            if any(idx in remove_indices for idx in chunk):
                continue
            c_words = [normalise_text(words[j]["word"]) for j in chunk]
            c_text = " ".join(c_words)
            # If chunk is short and not a complete phrase in the script
            if len(c_words) <= 8 and c_text not in script_n:
                # Check if a later chunk starts with the same words
                for later in chunks[i+1:]:
                    lw = [normalise_text(words[k]["word"]) for k in later]
                    lt = " ".join(lw)
                    if len(c_words) >= 2 and lt.startswith(c_text):
                        for idx in chunk:
                            remove_indices.add(idx)
                        log(f"    Script fragment removed: '{c_text}'")
                        break

    return remove_indices


def build_keep_segments(whisper_result, total_duration, silence_thresh=0.8, script_text=None):
    """
    Build list of (start, end) segments to keep based on Whisper word timestamps.
    1. Removes silences longer than silence_thresh
    2. Detects and removes false starts and repeated takes
    3. Cross-references with script_text if provided
    """
    words = []
    for seg in whisper_result.get("segments", []):
        for w in seg.get("words", []):
            if w.get("start") is not None and w.get("end") is not None:
                words.append({
                    "word": w["word"].strip().lower(),
                    "start": float(w["start"]),
                    "end": float(w["end"])
                })

    if not words:
        segments = whisper_result.get("segments", [])
        if segments:
            return [(float(s["start"]), float(s["end"])) for s in segments]
        return [(0, total_duration)]

    # Find false starts / retakes to remove
    remove_indices = find_false_starts(words, script_text=script_text)
    if remove_indices:
        log(f"    Removing {len(remove_indices)} words from false starts/retakes")

    # Build keep segments from remaining words
    keep_words = [w for i, w in enumerate(words) if i not in remove_indices]

    if not keep_words:
        keep_words = words  # Fallback — keep everything

    # Merge into segments separated by silence_thresh
    keep = []
    seg_start = keep_words[0]["start"]
    seg_end = keep_words[0]["end"]

    for i in range(1, len(keep_words)):
        gap = keep_words[i]["start"] - seg_end
        if gap > silence_thresh:
            if seg_end > seg_start:
                keep.append((max(0, seg_start - 0.05), seg_end + 0.05))
            seg_start = keep_words[i]["start"]
        seg_end = keep_words[i]["end"]

    if seg_end > seg_start:
        keep.append((max(0, seg_start - 0.05), min(total_duration, seg_end + 0.2)))

    return keep

def remove_silences_and_cuts(inp, out, whisper_result, script_text=None):
    """
    Properly cut silences by identifying keep segments from Whisper transcription
    and using ffmpeg concat to join them. Both audio and video cut together — no sync issues.
    """
    duration = get_video_duration(inp)
    if not duration:
        log_warn("Could not get video duration — using original")
        shutil.copy(inp, out)
        return

    keep_segments = build_keep_segments(whisper_result, duration, SILENCE_THRESH_S, script_text=script_text)

    if not keep_segments:
        log_warn("No keep segments found — using original")
        shutil.copy(inp, out)
        return

    log(f"    Keeping {len(keep_segments)} segments from {duration:.1f}s video")

    if len(keep_segments) == 1:
        # Single segment — just trim
        start, end = keep_segments[0]
        cmd = ["ffmpeg","-y",
               "-ss", str(start),
               "-to", str(end),
               "-i", str(inp),
               "-c:v","libx264","-c:a","aac",
               "-preset","fast","-crf","23",
               str(out)]
        r = subprocess.run(cmd, capture_output=True)
        if r.returncode != 0:
            log_warn(f"Trim failed: {r.stderr[-200:]}")
            shutil.copy(inp, out)
        return

    # Multiple segments — use concat
    # Create temp clip for each segment then concat
    tmp = inp.parent
    clip_paths = []

    for idx, (start, end) in enumerate(keep_segments):
        if end - start < 0.3:  # Skip very short clips
            continue
        clip_path = tmp / f"clip_{idx:04d}.mp4"
        cmd = ["ffmpeg","-y",
               "-ss", str(start),
               "-to", str(end),
               "-i", str(inp),
               "-c:v","libx264","-c:a","aac",
               "-preset","fast","-crf","23",
               "-avoid_negative_ts","make_zero",
               str(clip_path)]
        r = subprocess.run(cmd, capture_output=True)
        if r.returncode == 0 and clip_path.exists():
            clip_paths.append(clip_path)

    if not clip_paths:
        log_warn("No clips created — using original")
        shutil.copy(inp, out)
        return

    # Write concat list
    concat_file = tmp / "concat.txt"
    lines_txt = []
    for p in clip_paths:
        lines_txt.append("file '" + str(p).replace("\\", "/") + "'")
    concat_file.write_text("\n".join(lines_txt), encoding="utf-8")

    # Concat all clips
    cmd = ["ffmpeg","-y",
           "-f","concat","-safe","0",
           "-i", str(concat_file),
           "-c","copy",
           str(out)]
    r = subprocess.run(cmd, capture_output=True)

    if r.returncode != 0:
        log_warn(f"Concat failed: {r.stderr[-200:]} — using original")
        shutil.copy(inp, out)

    # Cleanup clips
    for p in clip_paths:
        try: p.unlink()
        except: pass
    try: concat_file.unlink()
    except: pass

def get_windows_font():
    """Find a usable font file on Windows."""
    candidates = [
        "C:/Windows/Fonts/arialbd.ttf",
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/calibrib.ttf",
        "C:/Windows/Fonts/calibri.ttf",
        "C:/Windows/Fonts/verdana.ttf",
        "C:/Windows/Fonts/tahoma.ttf",
    ]
    for f in candidates:
        if Path(f).exists():
            return f
    return None

def add_title_card(inp, out, title):
    font = get_windows_font()
    safe = title.replace("'","").replace('"',"").replace(":","").replace(",","").replace("\\","").strip()
    if not safe:
        shutil.copy(inp, out)
        return
    words = safe.split()
    if font:
        fp = font.replace("\\", "/")
        if len(words) > 5:
            mid = len(words) // 2
            t1 = " ".join(words[:mid])
            t2 = " ".join(words[mid:])
            vf = (f"drawtext=fontfile=\'{fp}\':text=\'{t1}\':fontsize={TITLE_FONT_SIZE}:"
                  f"fontcolor=white:borderw=3:bordercolor=black:"
                  f"x=(w-text_w)/2:y=(h/2-text_h-10):enable=\'between(t,0,{TITLE_SECS})\',"
                  f"drawtext=fontfile=\'{fp}\':text=\'{t2}\':fontsize={TITLE_FONT_SIZE}:"
                  f"fontcolor=white:borderw=3:bordercolor=black:"
                  f"x=(w-text_w)/2:y=(h/2+10):enable=\'between(t,0,{TITLE_SECS})\'")
        else:
            vf = (f"drawtext=fontfile=\'{fp}\':text=\'{safe}\':fontsize={TITLE_FONT_SIZE}:"
                  f"fontcolor=white:borderw=3:bordercolor=black:"
                  f"x=(w-text_w)/2:y=(h-text_h)/2:enable=\'between(t,0,{TITLE_SECS})\'")
    else:
        vf = (f"drawtext=text=\'{safe}\':fontsize={TITLE_FONT_SIZE}:"
              f"fontcolor=white:borderw=3:bordercolor=black:"
              f"x=(w-text_w)/2:y=(h-text_h)/2:enable=\'between(t,0,{TITLE_SECS})\'")
    cmd = ["ffmpeg", "-y", "-i", str(inp), "-vf", vf, "-c:a", "copy", str(out)]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        log_warn(f"Title card failed — using without")
        shutil.copy(inp, out)

def add_captions(inp, out, whisper_result):
    """Burn subtitles into video using SRT file. Windows-compatible approach."""
    srt = inp.parent / (inp.stem + "_subs.srt")
    font = get_windows_font()

    # Write SRT
    lines = []
    idx = 1
    for seg in whisper_result.get("segments", []):
        text = seg.get("text","").strip()
        if not text:
            continue
        def fmt_t(s):
            h=int(s//3600);m=int((s%3600)//60);sc=int(s%60);ms=int((s%1)*1000)
            return f"{h:02d}:{m:02d}:{sc:02d},{ms:03d}"
        lines.append(f"{idx}\n{fmt_t(seg['start'])} --> {fmt_t(seg['end'])}\n{text}\n")
        idx += 1

    if not lines:
        log_warn("No subtitle segments — skipping captions")
        shutil.copy(inp, out)
        return

    srt.write_text("\n".join(lines), encoding="utf-8")

    # Build subtitle filter — Windows needs forward slashes and escaped colons
    srt_path_escaped = str(srt).replace("\\", "/").replace(":", "\\\\:")

    style = "FontSize=18,PrimaryColour=&H00ffffff,OutlineColour=&H00000000,Outline=2,Shadow=1,Alignment=2,MarginV=40"
    if font:
        font_name = Path(font).stem  # e.g. "arialbd"
        style += f",FontName={font_name}"

    vf = f"subtitles='{srt_path_escaped}':force_style='{style}'"

    cmd = ["ffmpeg","-y","-i",str(inp),"-vf",vf,"-c:a","copy",str(out)]
    r = subprocess.run(cmd, capture_output=True)

    if r.returncode != 0:
        err = r.stderr[-300:].decode("utf-8","ignore") if r.stderr else ""
        log_warn(f"Captions failed: {err[-150:]} — using without captions")
        shutil.copy(inp, out)

    if srt.exists():
        try: srt.unlink()
        except: pass

ZERNIO_BASE = "https://zernio.com/api/v1"
ZERNIO_HEADERS = {"Authorization": f"Bearer {ZERNIO_TOKEN}", "Content-Type": "application/json"}

def get_zernio_accounts():
    """Get all connected social accounts from Zernio filtered to our target platforms."""
    try:
        r = requests.get(f"{ZERNIO_BASE}/accounts", headers=ZERNIO_HEADERS, timeout=10)
        if r.status_code != 200:
            log_warn(f"Zernio accounts fetch failed: {r.status_code} {r.text[:100]}")
            return []
        data = r.json()
        accounts = data if isinstance(data, list) else data.get("accounts", data.get("data", []))
        matched = [a for a in accounts if any(p in a.get("platform","").lower() for p in PLATFORMS)]
        if not matched:
            log_warn(f"No accounts matching {PLATFORMS} found. Connect them at zernio.com")
        return matched
    except Exception as e:
        log_warn(f"Zernio accounts error: {e}")
        return []

def schedule_to_zernio(drive_link, title, description, scheduled_at):
    """Schedule a video post to all connected platform accounts via Zernio."""
    accounts = get_zernio_accounts()
    if not accounts:
        return False

    # Build platforms list for the post
    platforms_payload = []
    for account in accounts:
        platform = account.get("platform","").lower()
        account_id = account.get("_id") or account.get("id")
        entry = {"platform": platform, "accountId": account_id}
        # Platform-specific data
        if platform == "youtube":
            entry["platformSpecificData"] = {
                "title": title,
                "visibility": "public",
                "madeForKids": False
            }
        elif platform == "tiktok":
            entry["platformSpecificData"] = {"privacyLevel": "PUBLIC_TO_EVERYONE"}
        platforms_payload.append(entry)

    payload = {
        "content": f"{title}\n\n{description}",
        "mediaItems": [{"type": "video", "url": drive_link}],
        "platforms": platforms_payload,
        "scheduledFor": scheduled_at
    }

    try:
        r = requests.post(f"{ZERNIO_BASE}/posts", headers=ZERNIO_HEADERS, json=payload, timeout=20)
        if r.status_code in (200, 201):
            post_data = r.json()
            post_id = post_data.get("post", {}).get("_id", "?")
            log_ok(f"Scheduled to {len(platforms_payload)} platform(s) for {scheduled_at} (post id: {post_id})")
            return True
        else:
            log_warn(f"Zernio scheduling failed: {r.status_code} {r.text[:200]}")
            return False
    except Exception as e:
        log_warn(f"Zernio scheduling error: {e}")
        return False

def calc_times(n):
    times = []
    day = datetime.utcnow().date() + timedelta(days=1)
    slot = 0
    for _ in range(n):
        h,m = map(int, POST_TIMES[slot % len(POST_TIMES)].split(":"))
        dt = datetime(day.year,day.month,day.day,h,m,0)
        times.append(dt.strftime("%Y-%m-%dT%H:%M:%S+00:00"))
        slot += 1
        if slot % len(POST_TIMES) == 0:
            day += timedelta(days=1)
    return times

# ── Main loop ─────────────────────────────────────────────────────────────────
processed = []
failed = []
used_scripts = set()
schedule_times = calc_times(len(raw_files))
tmpdir = Path(tempfile.mkdtemp(prefix="videoagent_"))

try:
    for i, raw_file in enumerate(raw_files):
        fname = raw_file["name"]
        fid = raw_file["id"]
        log(f"\n--- [{i+1}/{len(raw_files)}] {fname} ---")

        try:
            # Download
            raw_path = tmpdir / fname
            download_from_drive(fid, fname, raw_path)

            # Transcribe
            log("Transcribing...")
            result = model.transcribe(str(raw_path), word_timestamps=True)
            text = result.get("text","")
            log(f"Transcription: {text[:80]}...")

            # Match
            available = [s for s in all_scripts if id(s) not in used_scripts]
            if not available:
                log_err("No more scripts to match")
                failed.append({"file":fname,"reason":"No scripts left"})
                continue

            matched, score = match_script(text, available)
            log(f"Matched: '{matched.get('title','')}' — confidence {score}%")

            if score < 35:
                log_warn(f"Low confidence ({score}%) — check output carefully")

            used_scripts.add(id(matched))
            title = matched.get("title", fname.replace(".mp4",""))
            description = matched.get("description","")

            # Edit
            p1 = tmpdir / f"{i}_silent.mp4"
            script_text = matched.get("script", "")
            remove_silences_and_cuts(raw_path, p1, result, script_text=script_text)
            log_ok("Silences and pauses removed (audio/video in sync)")

            p2 = tmpdir / f"{i}_titled.mp4"
            add_title_card(p1, p2, title)
            log_ok("Title card added")

            p3 = tmpdir / f"{i}_final.mp4"
            if CAPTIONS_ENABLED:
                add_captions(p2, p3, result)
                log_ok("Captions added")
            else:
                shutil.copy(p2, p3)

            # Upload
            safe = re.sub(r"[^\w\s-]","",title)[:50].strip()
            out_name = f"{safe}.mp4"
            drive_id, drive_link = upload_to_drive(p3, EDITED_FOLDER_ID, out_name)
            log_ok(f"Uploaded: {out_name}")

            # Schedule
            sched_time = schedule_times[i] if i < len(schedule_times) else schedule_times[-1]
            scheduled = schedule_to_zernio(drive_link, title, description, sched_time)

            # Update batch JSON
            bn = matched["_batch"]
            idx = matched["_idx"]
            batch_data[bn]["scripts"][idx]["status"] = "scheduled"
            batch_data[bn]["scripts"][idx]["scheduledAt"] = sched_time
            batch_data[bn]["scripts"][idx]["driveLink"] = drive_link

            # Save processed log
            processed_log[fid] = {
                "file_name": fname,
                "script_title": title,
                "processed_at": datetime.utcnow().isoformat(),
                "drive_link": drive_link,
                "scheduled_at": sched_time
            }
            PROCESSED_LOG.write_text(json.dumps(processed_log, indent=2))

            processed.append({
                "file": fname, "title": title,
                "score": score, "scheduled_at": sched_time,
                "scheduled": scheduled, "link": drive_link
            })
            log_ok(f"Complete: {title}")

        except Exception as e:
            err = traceback.format_exc()
            log_err(f"Failed: {fname} — {e}")
            log(err, "DEBUG")
            failed.append({"file": fname, "reason": str(e), "detail": err})
            continue

    # Save updated batches to GitHub
    if processed:
        log("\nSaving to GitHub...")
        for bn, data in batch_data.items():
            try:
                gh_put_file(f"batch-{bn}.json", data, batch_shas[bn],
                           f"VideoAgent: {len(processed)} videos scheduled")
                log_ok(f"batch-{bn}.json updated")
            except Exception as e:
                log_err(f"GitHub save failed for batch-{bn}: {e}")

finally:
    shutil.rmtree(tmpdir, ignore_errors=True)

# ── Summary ───────────────────────────────────────────────────────────────────
log("\n" + "="*55)
log("SUMMARY")
log("="*55)
log(f"Processed: {len(processed)}   Failed: {len(failed)}")
log("")

summary_lines = []
for p in processed:
    line = f"✓ {p['title']} | {p['scheduled_at']} | match {p['score']}%"
    log(line)
    summary_lines.append(line)

for f in failed:
    line = f"✗ {f['file']} — {f['reason']}"
    log(line, "ERROR")
    summary_lines.append(line)

# Email report
if NOTIFY_EMAIL:
    if failed:
        subject = f"{len(failed)} FAILED, {len(processed)} succeeded"
        body = f"VideoAgent run complete.\n\n{len(processed)} processed, {len(failed)} failed.\n\n"
        body += "FAILURES:\n"
        for f in failed:
            body += f"\n{f['file']}\nReason: {f['reason']}\n\nDetail:\n{f.get('detail','')}\n"
        body += "\nSUCCESSES:\n" + "\n".join(summary_lines[:len(processed)])
        send_report(subject, body, is_error=True)
    elif processed:
        subject = f"{len(processed)} videos scheduled"
        body = f"VideoAgent run complete.\n\n{len(processed)} videos processed and scheduled.\n\n"
        body += "\n".join(summary_lines)
        send_report(subject, body)

log(f"\nFull log: {LOG_FILE}")
