/**
 * Audio Extractor Server
 *
 * Standalone HTTP server for extracting and splitting audio from Bilibili videos.
 * Dependencies: yt-dlp, ffmpeg (must be in PATH or configured below).
 *
 * Usage: node server/audio-extractor-server.mjs
 * Default port: 8789
 */

import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data", "audio");
const PORT = parseInt(process.env.AUDIO_PORT || "8789", 10);
const MUSIC_DETECTOR_PY = path.join(__dirname, "music_detector.py");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/** Parse JSON body from IncomingMessage */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/** Send JSON response */
function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

/** Generate a short unique id */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Get video directory (each video gets its own folder, with optional page subdir) */
function videoDir(videoId, page) {
  const p = parseInt(page, 10);
  const dir = (p > 1)
    ? path.join(DATA_DIR, videoId, `p${p}`)
    : path.join(DATA_DIR, videoId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Parse page number from a bilibili URL like ?p=3 */
function parsePageFromUrl(url) {
  const m = String(url).match(/[?&]p=(\d+)/);
  return m ? parseInt(m[1], 10) : 1;
}

/** Sanitize filename */
function sanitize(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 100);
}

/** Format seconds to HH:MM:SS for song labels */
function fmtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/*  Core: Extract audio from Bilibili video                           */
/* ------------------------------------------------------------------ */

/**
 * Extract audio from a Bilibili video URL using yt-dlp.
 * Returns the path to the extracted audio file.
 */
async function extractAudio(url, videoId, page) {
  const dir = videoDir(videoId, page);
  const outputTemplate = path.join(dir, "source.%(ext)s");

  // Check if already extracted
  const existing = fs.readdirSync(dir).find((f) => f.startsWith("source."));
  if (existing) {
    return { file: path.join(dir, existing), cached: true, dir };
  }

  const args = [
    "--no-playlist",
    "-x",                          // extract audio only
    "--audio-format", "mp3",       // convert to mp3
    "--audio-quality", "0",        // best quality
    "-o", outputTemplate,
    "--no-check-certificates",
    url,
  ];

  try {
    const { stdout, stderr } = await execFileAsync("yt-dlp", args, {
      timeout: 300_000, // 5 min timeout
      maxBuffer: 10 * 1024 * 1024,
    });
    console.log("[yt-dlp stdout]", stdout.slice(0, 500));
    if (stderr) console.log("[yt-dlp stderr]", stderr.slice(0, 500));
  } catch (err) {
    throw new Error(`yt-dlp failed: ${err.message}`);
  }

  // Find the output file
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("source."));
  if (files.length === 0) throw new Error("yt-dlp produced no output file");
  return { file: path.join(dir, files[0]), cached: false, dir };
}

/* ------------------------------------------------------------------ */
/*  Core: Detect music segments via Python librosa (music vs speech)  */
/* ------------------------------------------------------------------ */

/**
 * Use Python music_detector.py (librosa-based) to classify audio segments
 * as music or speech. Returns only music segments.
 */
async function detectMusicSegments(audioPath, opts = {}) {
  const {
    minDuration = 15,
    hop = 1.0,
    window = 3.0,
  } = opts;

  return new Promise((resolve, reject) => {
    const args = [
      MUSIC_DETECTOR_PY,
      audioPath,
      "--min-duration", String(minDuration),
      "--hop", String(hop),
      "--window", String(window),
    ];

    console.log(`[detect-music] Running: python ${args.join(" ")}`);
    const proc = spawn("python", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => {
      const line = d.toString();
      stderr += line;
      // Forward progress lines to console
      for (const l of line.split("\n").filter(Boolean)) {
        console.log(`  ${l}`);
      }
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`music_detector.py exited with code ${code}: ${stderr}`));
      }
      try {
        const result = JSON.parse(stdout);
        if (result.error) return reject(new Error(result.error));
        resolve(result);
      } catch (e) {
        reject(new Error(`Failed to parse music_detector output: ${stdout.slice(0, 200)}`));
      }
    });
    proc.on("error", (err) => reject(new Error(`Python not found or failed: ${err.message}`)));
  });
}

/* ------------------------------------------------------------------ */
/*  Core: Detect song segments via silence detection (legacy)         */
/* ------------------------------------------------------------------ */

/**
 * Use ffmpeg silencedetect to find silence gaps, then invert to get "sound" segments.
 * Returns array of { start, end, duration } in seconds.
 */
async function detectSegments(audioPath, opts = {}) {
  const {
    silenceThresh = -35,   // dB threshold for silence
    silenceDuration = 3,   // minimum silence duration (seconds)
    minSegment = 15,       // minimum segment duration to keep (seconds)
  } = opts;

  return new Promise((resolve, reject) => {
    const args = [
      "-i", audioPath,
      "-af", `silencedetect=noise=${silenceThresh}dB:d=${silenceDuration}`,
      "-f", "null",
      "-",
    ];

    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      // Parse silencedetect output
      const silenceStarts = [];
      const silenceEnds = [];
      for (const line of stderr.split("\n")) {
        const startMatch = line.match(/silence_start:\s*([\d.]+)/);
        const endMatch = line.match(/silence_end:\s*([\d.]+)/);
        if (startMatch) silenceStarts.push(parseFloat(startMatch[1]));
        if (endMatch) silenceEnds.push(parseFloat(endMatch[1]));
      }

      // Get total duration
      const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
      let totalDuration = 0;
      if (durMatch) {
        totalDuration =
          parseInt(durMatch[1]) * 3600 +
          parseInt(durMatch[2]) * 60 +
          parseInt(durMatch[3]) +
          parseInt(durMatch[4]) / 100;
      }

      // Build sound segments (gaps between silences)
      const segments = [];
      let cursor = 0;

      for (let i = 0; i < silenceStarts.length; i++) {
        const segStart = cursor;
        const segEnd = silenceStarts[i];
        if (segEnd - segStart >= minSegment) {
          segments.push({
            start: Math.round(segStart * 100) / 100,
            end: Math.round(segEnd * 100) / 100,
            duration: Math.round((segEnd - segStart) * 100) / 100,
          });
        }
        // Move cursor to end of this silence
        if (i < silenceEnds.length) {
          cursor = silenceEnds[i];
        }
      }

      // Last segment after final silence
      if (totalDuration > 0 && cursor < totalDuration) {
        const remaining = totalDuration - cursor;
        if (remaining >= minSegment) {
          segments.push({
            start: Math.round(cursor * 100) / 100,
            end: Math.round(totalDuration * 100) / 100,
            duration: Math.round(remaining * 100) / 100,
          });
        }
      }

      // If no silence detected, return the whole file as one segment
      if (segments.length === 0 && totalDuration > 0) {
        segments.push({
          start: 0,
          end: Math.round(totalDuration * 100) / 100,
          duration: Math.round(totalDuration * 100) / 100,
        });
      }

      resolve({ segments, totalDuration: Math.round(totalDuration * 100) / 100 });
    });
    proc.on("error", (err) => reject(new Error(`ffmpeg not found or failed: ${err.message}`)));
  });
}

/* ------------------------------------------------------------------ */
/*  Core: Split audio into segments                                   */
/* ------------------------------------------------------------------ */

/**
 * Split audio file into segments using ffmpeg.
 * @param {string} audioPath - source audio file
 * @param {Array<{start: number, end: number, label?: string}>} segments
 * @returns {Array<{file: string, label: string, start: number, end: number}>}
 */
async function splitAudio(audioPath, segments, videoId, page) {
  const dir = videoDir(videoId, page);
  // Songs go into a "music" subdirectory
  const musicDir = path.join(dir, "music");
  if (!fs.existsSync(musicDir)) fs.mkdirSync(musicDir, { recursive: true });
  const results = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const label = seg.label || `segment_${String(i + 1).padStart(2, "0")}`;
    const outFile = path.join(musicDir, `${sanitize(label)}.mp3`);

    const args = [
      "-y",
      "-i", audioPath,
      "-ss", String(seg.start),
      "-to", String(seg.end),
      "-acodec", "libmp3lame",
      "-q:a", "2",
      outFile,
    ];

    try {
      await execFileAsync("ffmpeg", args, { timeout: 120_000 });
      results.push({
        file: `music/${path.basename(outFile)}`,
        label,
        start: seg.start,
        end: seg.end,
        duration: Math.round((seg.end - seg.start) * 100) / 100,
        index: seg.index ?? (i + 1),
      });
    } catch (err) {
      console.error(`[split] Failed segment ${i}:`, err.message);
    }
  }

  // Save metadata with full traceability info (index, page, originalName)
  saveMusicMetadata(musicDir, results, page);

  return results;
}

/**
 * Save / load music metadata (start, end, duration, index, page, originalName per song file).
 * Stored as music/metadata.json inside the video page directory.
 * This metadata is the authoritative source for the song library,
 * allowing it to work independently from the extraction tool.
 */
function saveMusicMetadata(musicDir, songs, page) {
  const metaPath = path.join(musicDir, "metadata.json");
  // Merge with existing metadata to preserve user renames
  let existing = {};
  if (fs.existsSync(metaPath)) {
    try { existing = JSON.parse(fs.readFileSync(metaPath, "utf-8")); } catch {}
  }
  const meta = { ...existing };
  for (const s of songs) {
    const fname = s.file.replace(/^music\//, "");
    meta[fname] = {
      start: s.start,
      end: s.end,
      duration: s.duration,
      index: s.index ?? 0,
      page: page ?? 1,
      originalName: fname,
      label: s.label,
    };
  }
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
}

function loadMusicMetadata(musicDir) {
  const metaPath = path.join(musicDir, "metadata.json");
  if (!fs.existsSync(metaPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch { return {}; }
}

/** 全部分轨合并（不删原片） */
const MERGE_OUTPUT_BASENAME = "merged_full_span.mp3";
/** 选中连续分轨合并（会删除被选中的原分轨） */
const MERGE_SELECTION_BASENAME = "merged_selection.mp3";

function isMergeOutputBasename(f) {
  return f === MERGE_OUTPUT_BASENAME || f === MERGE_SELECTION_BASENAME;
}

function parseTimeRangeFromFileName(fname) {
  const timeMatch = fname.match(/\[(\d{2})[_:](\d{2})[_:](\d{2})-(\d{2})[_:](\d{2})[_:](\d{2})\]/);
  if (!timeMatch) return null;
  const start =
    parseInt(timeMatch[1], 10) * 3600 + parseInt(timeMatch[2], 10) * 60 + parseInt(timeMatch[3], 10);
  const end =
    parseInt(timeMatch[4], 10) * 3600 + parseInt(timeMatch[5], 10) * 60 + parseInt(timeMatch[6], 10);
  return { start, end };
}

/**
 * 普通分轨（排除合并结果文件），按时间起点排序。用于全轨合并、选中合并的连续性判定。
 * @returns {Array<{ file: string, start: number, end: number, label: string }>}
 */
function buildOrderedNormalSegments(musicDir) {
  if (!fs.existsSync(musicDir)) return [];
  const meta = loadMusicMetadata(musicDir);
  const out = [];
  for (const f of fs.readdirSync(musicDir)) {
    if (f === "metadata.json" || isMergeOutputBasename(f)) continue;
    const full = path.join(musicDir, f);
    if (fs.statSync(full).isDirectory() || !f.toLowerCase().endsWith(".mp3")) continue;

    const m = meta[f] || {};
    let start = m.start;
    let end = m.end;
    if (typeof start !== "number" || typeof end !== "number" || (start === 0 && end === 0)) {
      const parsed = parseTimeRangeFromFileName(f);
      if (parsed) {
        start = parsed.start;
        end = parsed.end;
      }
    }
    if (typeof start === "number" && typeof end === "number" && end > start) {
      out.push({ file: f, start, end, label: m.label || f.replace(/\.mp3$/i, "") });
    }
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

/**
 * 收集各分轨在完整 source 上的时间范围（排除合并输出文件本身）。
 * @returns {Array<{ file: string, start: number, end: number }>}
 */
function collectSegmentBoundsForMerge(musicDir) {
  return buildOrderedNormalSegments(musicDir).map((r) => ({ file: r.file, start: r.start, end: r.end }));
}

/**
 * 按盘上实际 mp3、按起播时间重排，将 metadata 中 index 置为 1..N，并删已无文件的条目。
 * 合并后只保留与当前分轨文件一致的索引信息。
 */
function reindexAllMusicInDir(musicDir, page) {
  if (!fs.existsSync(musicDir)) return;
  const meta = loadMusicMetadata(musicDir);
  const onDisk = fs
    .readdirSync(musicDir)
    .filter((f) => f !== "metadata.json" && f.toLowerCase().endsWith(".mp3"))
    .filter((f) => {
      const fp = path.join(musicDir, f);
      return fs.existsSync(fp) && fs.statSync(fp).isFile();
    });
  const onSet = new Set(onDisk);
  for (const k of Object.keys(meta)) {
    if (!onSet.has(k)) delete meta[k];
  }
  const rows = onDisk.map((f) => {
    const m = meta[f] || {};
    let start = m.start;
    let end = m.end;
    if (typeof start !== "number" || typeof end !== "number" || (start === 0 && end === 0)) {
      const parsed = parseTimeRangeFromFileName(f);
      if (parsed) {
        start = parsed.start;
        end = parsed.end;
      }
    }
    if (typeof start !== "number") start = 0;
    if (typeof end !== "number") end = 0;
    return { f, start, end };
  });
  rows.sort((a, b) => a.start - b.start || a.end - b.end || a.f.localeCompare(b.f));
  const pg = page != null && page > 0 ? page : 1;
  for (let i = 0; i < rows.length; i++) {
    const f = rows[i].f;
    const idx = i + 1;
    if (!meta[f]) {
      const dur = rows[i].end > rows[i].start ? Math.round((rows[i].end - rows[i].start) * 100) / 100 : 0;
      meta[f] = {
        start: rows[i].start,
        end: rows[i].end,
        duration: dur,
        index: idx,
        page: pg,
        originalName: f,
        label: f.replace(/\.mp3$/i, ""),
      };
    } else {
      meta[f] = { ...meta[f], index: idx, page: meta[f].page != null ? meta[f].page : pg };
    }
  }
  const metaPath = path.join(musicDir, "metadata.json");
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
}

/**
 * 从完整 source 截取 [tFirst, tLast] 为一条音轨。中间原片若存在非歌曲间隙，保留为原样（不剪接多段、不补静音段）。
 * 等效于「从最早分轨起点到最晚分轨终点」一条连续时间线。
 */
async function writeMergedFullSpanFromSource(audioPath, musicDir, page) {
  const bounds = collectSegmentBoundsForMerge(musicDir);
  if (bounds.length === 0) {
    throw new Error("没有分轨时间信息：请先完成「分割歌曲」或保留可解析时间码的文件名");
  }
  const tFirst = Math.min(...bounds.map((b) => b.start));
  const tLast = Math.max(...bounds.map((b) => b.end));
  if (!(tLast > tFirst)) {
    throw new Error("分轨时间范围无效");
  }

  const outFile = path.join(musicDir, MERGE_OUTPUT_BASENAME);
  const args = [
    "-y",
    "-i",
    audioPath,
    "-ss",
    String(tFirst),
    "-to",
    String(tLast),
    "-acodec",
    "libmp3lame",
    "-q:a",
    "2",
    outFile,
  ];
  await execFileAsync("ffmpeg", args, { timeout: 600_000 });

  const duration = Math.round((tLast - tFirst) * 100) / 100;
  const result = {
    file: `music/${MERGE_OUTPUT_BASENAME}`,
    label: `【合并】${fmtTime(tFirst)} — ${fmtTime(tLast)}（含间隙原声）`,
    start: tFirst,
    end: tLast,
    duration,
    index: 0,
  };
  saveMusicMetadata(musicDir, [result], page);
  reindexAllMusicInDir(musicDir, page);
  const m = loadMusicMetadata(musicDir);
  const re = m[MERGE_OUTPUT_BASENAME] || {};
  return { ...result, index: re.index != null ? re.index : result.index };
}

/**
 * 将「按时间排序后两两相邻」的若干分轨合并为一轨，从 source 一次截取；合并成功后删除原分轨文件与 metadata 项。
 */
async function mergeSelectedConsecutiveAndDeleteFromSource(audioPath, musicDir, page, fileNames) {
  const basenames = (fileNames || []).map((x) => String(x).replace(/^music\//, "").trim()).filter(Boolean);
  if (basenames.length < 2) {
    throw new Error("请至少选择 2 个分轨");
  }
  for (const f of basenames) {
    if (isMergeOutputBasename(f)) {
      throw new Error("不能选择合并结果文件");
    }
  }
  const set = new Set(basenames);
  if (set.size !== basenames.length) {
    throw new Error("选中了重复项");
  }

  const ordered = buildOrderedNormalSegments(musicDir);
  const byFile = new Map(ordered.map((r) => [r.file, r]));
  for (const f of basenames) {
    if (!byFile.has(f)) {
      throw new Error(`分轨不存在或不是普通分轨: ${f}`);
    }
  }

  const selectedIndices = [];
  for (let i = 0; i < ordered.length; i++) {
    if (set.has(ordered[i].file)) selectedIndices.push(i);
  }
  if (selectedIndices.length !== set.size) {
    throw new Error("选中项与分轨表不一致");
  }
  for (let j = 1; j < selectedIndices.length; j++) {
    if (selectedIndices[j] !== selectedIndices[j - 1] + 1) {
      throw new Error("所选分轨在时间上须连续：按起点排序后必须相邻，例如可勾选 01、02、03，不可跳段");
    }
  }

  const rows = selectedIndices.map((i) => ordered[i]);
  const t0 = Math.min(...rows.map((r) => r.start));
  const t1 = Math.max(...rows.map((r) => r.end));
  if (!(t1 > t0)) {
    throw new Error("时间范围无效");
  }

  const outFile = path.join(musicDir, MERGE_SELECTION_BASENAME);
  const args = [
    "-y",
    "-i",
    audioPath,
    "-ss",
    String(t0),
    "-to",
    String(t1),
    "-acodec",
    "libmp3lame",
    "-q:a",
    "2",
    outFile,
  ];
  await execFileAsync("ffmpeg", args, { timeout: 600_000 });

  const meta = loadMusicMetadata(musicDir);
  delete meta[MERGE_SELECTION_BASENAME];

  for (const r of rows) {
    const fp = path.join(musicDir, r.file);
    if (fs.existsSync(fp)) {
      await fsp.unlink(fp);
    }
    delete meta[r.file];
  }

  const duration = Math.round((t1 - t0) * 100) / 100;
  const label = `【合并】${rows.length}段（${fmtTime(t0)}—${fmtTime(t1)}）`;
  meta[MERGE_SELECTION_BASENAME] = {
    start: t0,
    end: t1,
    duration,
    index: 0,
    page,
    originalName: MERGE_SELECTION_BASENAME,
    label,
  };
  const metaPath = path.join(musicDir, "metadata.json");
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");

  reindexAllMusicInDir(musicDir, page);
  const mAfter = loadMusicMetadata(musicDir);
  const mSel = mAfter[MERGE_SELECTION_BASENAME] || {};

  return {
    file: `music/${MERGE_SELECTION_BASENAME}`,
    label,
    start: t0,
    end: t1,
    duration,
    index: mSel.index != null ? mSel.index : 0,
    deleted: rows.map((r) => r.file),
  };
}

function updateMusicMetadataLabel(musicDir, fileName, newLabel) {
  const meta = loadMusicMetadata(musicDir);
  if (meta[fileName]) {
    meta[fileName] = {
      ...meta[fileName],
      label: newLabel,
      renamedAt: new Date().toISOString(),
    };
    const metaPath = path.join(musicDir, "metadata.json");
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
  }
}

function updateMusicMetadataDelete(musicDir, fileName) {
  const meta = loadMusicMetadata(musicDir);
  const fname = fileName.replace(/^music\//, "");
  if (meta[fname]) {
    delete meta[fname];
    const metaPath = path.join(musicDir, "metadata.json");
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
  }
}

/**
 * Save video-level info (BV, URL, page, extract time) alongside the audio.
 * Stored as video_info.json in the video page directory.
 */
function saveVideoInfo(dir, info) {
  const infoPath = path.join(dir, "video_info.json");
  // Merge with existing info (don't overwrite fields already set)
  let existing = {};
  if (fs.existsSync(infoPath)) {
    try { existing = JSON.parse(fs.readFileSync(infoPath, "utf-8")); } catch {}
  }
  const merged = { ...existing, ...info, updatedAt: new Date().toISOString() };
  fs.writeFileSync(infoPath, JSON.stringify(merged, null, 2), "utf-8");
}

function loadVideoInfo(dir) {
  const infoPath = path.join(dir, "video_info.json");
  if (!fs.existsSync(infoPath)) return null;
  try { return JSON.parse(fs.readFileSync(infoPath, "utf-8")); } catch { return null; }
}

/* ------------------------------------------------------------------ */
/*  Core: Get audio duration                                          */
/* ------------------------------------------------------------------ */

async function getAudioDuration(audioPath) {
  try {
    const { stdout: probeOut } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      audioPath,
    ], { timeout: 10_000 });

    const val = parseFloat(probeOut);
    return isNaN(val) ? 0 : Math.round(val * 100) / 100;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/*  HTTP Server                                                       */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    /* ---- POST /extract — Extract audio from video URL ---- */
    if (req.method === "POST" && pathname === "/extract") {
      const body = await readBody(req);
      const videoUrl = body.url;
      const videoId = body.videoId || uid();
      const page = body.page || parsePageFromUrl(videoUrl);

      if (!videoUrl) return json(res, 400, { error: "Missing url" });

      console.log(`[extract] Starting: ${videoUrl} (id=${videoId}, page=${page})`);
      const { file, cached } = await extractAudio(videoUrl, videoId, page);
      const duration = await getAudioDuration(file);

      // Save video info for the library
      const extractDir = videoDir(videoId, page);
      saveVideoInfo(extractDir, {
        bvid: videoId,
        url: videoUrl,
        page,
        extractedAt: new Date().toISOString(),
      });

      return json(res, 200, {
        ok: true,
        videoId,
        page,
        audioFile: path.basename(file),
        cached,
        duration,
      });
    }

    /* ---- POST /detect — Detect song segments (legacy silence-based) ---- */
    if (req.method === "POST" && pathname === "/detect") {
      const body = await readBody(req);
      const { videoId, silenceThresh, silenceDuration, minSegment } = body;

      if (!videoId) return json(res, 400, { error: "Missing videoId" });

      const dir = videoDir(videoId);
      const sourceFile = fs.readdirSync(dir).find((f) => f.startsWith("source."));
      if (!sourceFile) return json(res, 404, { error: "Audio not extracted yet" });

      const audioPath = path.join(dir, sourceFile);
      console.log(`[detect] Analyzing: ${audioPath}`);

      const result = await detectSegments(audioPath, {
        silenceThresh: silenceThresh ?? -35,
        silenceDuration: silenceDuration ?? 3,
        minSegment: minSegment ?? 15,
      });

      return json(res, 200, { ok: true, ...result });
    }

    /* ---- POST /detect-music — Smart music detection via librosa ---- */
    if (req.method === "POST" && pathname === "/detect-music") {
      const body = await readBody(req);
      const { videoId, minDuration, hop, window: windowSec } = body;

      if (!videoId) return json(res, 400, { error: "Missing videoId" });

      const dir = videoDir(videoId);
      const sourceFile = fs.readdirSync(dir).find((f) => f.startsWith("source."));
      if (!sourceFile) return json(res, 404, { error: "Audio not extracted yet" });

      const audioPath = path.join(dir, sourceFile);
      console.log(`[detect-music] Analyzing: ${audioPath}`);

      const result = await detectMusicSegments(audioPath, {
        minDuration: minDuration ?? 15,
        hop: hop ?? 1.0,
        window: windowSec ?? 3.0,
      });

      return json(res, 200, { ok: true, ...result });
    }

    /* ---- POST /split — Split audio into segments ---- */
    if (req.method === "POST" && pathname === "/split") {
      const body = await readBody(req);
      const { videoId, segments } = body;

      if (!videoId || !segments?.length)
        return json(res, 400, { error: "Missing videoId or segments" });

      const dir = videoDir(videoId);
      const sourceFile = fs.readdirSync(dir).find((f) => f.startsWith("source."));
      if (!sourceFile) return json(res, 404, { error: "Audio not extracted yet" });

      const audioPath = path.join(dir, sourceFile);
      console.log(`[split] Splitting ${segments.length} segments from ${audioPath}`);

      const results = await splitAudio(audioPath, segments, videoId);
      return json(res, 200, { ok: true, segments: results });
    }

    /* ---- GET /files/:videoId — List extracted files ---- */
    if (req.method === "GET" && pathname.startsWith("/files/")) {
      const videoId = pathname.replace("/files/", "");
      const dir = videoDir(videoId);

      if (!fs.existsSync(dir)) return json(res, 404, { error: "Not found" });

      const files = fs.readdirSync(dir).map((f) => {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) return null;
        return { name: f, size: stat.size, mtime: stat.mtime.toISOString() };
      }).filter(Boolean);

      // Also list music subdirectory
      const musicDir = path.join(dir, "music");
      if (fs.existsSync(musicDir)) {
        for (const f of fs.readdirSync(musicDir)) {
          const stat = fs.statSync(path.join(musicDir, f));
          if (!stat.isDirectory()) {
            files.push({ name: `music/${f}`, size: stat.size, mtime: stat.mtime.toISOString() });
          }
        }
      }

      return json(res, 200, { ok: true, files });
    }

    /* ---- GET /status/:videoId — Check extraction status for a video (supports ?p=N) ---- */
    if (req.method === "GET" && pathname.startsWith("/status/")) {
      const videoId = pathname.replace("/status/", "");
      const qPage = parseInt(url.searchParams.get("p") || "1", 10);
      const dir = (qPage > 1)
        ? path.join(DATA_DIR, videoId, `p${qPage}`)
        : path.join(DATA_DIR, videoId);

      if (!fs.existsSync(dir)) {
        return json(res, 200, { ok: true, extracted: false, hasMusic: false, page: qPage, files: [] });
      }

      const sourceFile = fs.readdirSync(dir).find((f) => f.startsWith("source."));
      const musicDir = path.join(dir, "music");
      const musicFiles = fs.existsSync(musicDir)
        ? fs.readdirSync(musicDir).filter((f) => !fs.statSync(path.join(musicDir, f)).isDirectory() && f !== "metadata.json")
        : [];

      // Get duration if source exists
      let duration = 0;
      if (sourceFile) {
        duration = await getAudioDuration(path.join(dir, sourceFile));
      }

      // Load metadata for start/end times
      const meta = loadMusicMetadata(musicDir);

      return json(res, 200, {
        ok: true,
        page: qPage,
        extracted: !!sourceFile,
        hasMusic: musicFiles.length > 0,
        sourceFile: sourceFile || null,
        duration,
        musicFiles: musicFiles.map((f) => {
          const stat = fs.statSync(path.join(musicDir, f));
          const m = meta[f] || {};
          return {
            name: f,
            size: stat.size,
            start: m.start ?? 0,
            end: m.end ?? 0,
            duration: m.duration ?? 0,
            label: m.label,
            index: m.index ?? 0,
            page: m.page ?? qPage,
            originalName: m.originalName || f,
            renamedAt: m.renamedAt || null,
          };
        }),
      });
    }

    /* ---- POST /smart-extract — One-click: extract audio + detect music + split songs ---- */
    if (req.method === "POST" && pathname === "/smart-extract") {
      const body = await readBody(req);
      const videoUrl = body.url;
      const videoId = body.videoId || uid();
      const useLibrosa = body.useLibrosa !== false; // default to librosa

      if (!videoUrl) return json(res, 400, { error: "Missing url" });

      const page = body.page || parsePageFromUrl(videoUrl);
      console.log(`[smart-extract] Starting: ${videoUrl} (id=${videoId}, page=${page}, method=${useLibrosa ? "librosa" : "silence"})`);

      // Step 1: Extract audio
      const { file: audioFile, cached } = await extractAudio(videoUrl, videoId, page);
      const duration = await getAudioDuration(audioFile);
      console.log(`[smart-extract] Audio extracted (cached=${cached}, duration=${duration}s)`);

      // Step 2: Detect segments — use librosa music detection by default
      let detectResult;
      if (useLibrosa) {
        detectResult = await detectMusicSegments(audioFile, {
          minDuration: body.minDuration ?? body.minSegment ?? 15,
          hop: body.hop ?? 1.0,
          window: body.window ?? 3.0,
        });
      } else {
        detectResult = await detectSegments(audioFile, {
          silenceThresh: body.silenceThresh ?? -35,
          silenceDuration: body.silenceDuration ?? 3,
          minSegment: body.minSegment ?? 15,
        });
      }
      console.log(`[smart-extract] Detected ${detectResult.segments.length} segments`);

      if (detectResult.segments.length === 0) {
        return json(res, 200, {
          ok: true,
          videoId,
          audioFile: path.basename(audioFile),
          duration,
          cached,
          segments: [],
          message: "No song segments detected",
        });
      }

      // Filter out low-confidence segments (not real songs)
      const confidentSegments = detectResult.segments.filter(s => {
        // If confidence info is available, filter low-confidence ones
        if (typeof s.confidence === "number" && s.confidence < 0.12) {
          console.log(`[smart-extract] Skipping low-confidence segment (${s.start}-${s.end}, conf=${s.confidence})`);
          return false;
        }
        return true;
      });
      console.log(`[smart-extract] ${confidentSegments.length} confident segments (from ${detectResult.segments.length} detected)`);

      if (confidentSegments.length === 0) {
        return json(res, 200, {
          ok: true,
          videoId,
          audioFile: path.basename(audioFile),
          duration,
          cached,
          segments: [],
          message: "No confident song segments detected",
        });
      }

      // Step 3: Split into songs — name format: [start-end] 序号
      const labeledSegments = confidentSegments.map((s, i) => ({
        ...s,
        label: `[${fmtTime(s.start)}-${fmtTime(s.end)}] ${String(i + 1).padStart(2, "0")}`,
        index: i + 1,
      }));
      const splitResults = await splitAudio(audioFile, labeledSegments, videoId, page);
      console.log(`[smart-extract] Split into ${splitResults.length} songs`);

      // Save video info for the library
      const extractDir = videoDir(videoId, page);
      saveVideoInfo(extractDir, {
        bvid: videoId,
        url: videoUrl,
        page,
        extractedAt: new Date().toISOString(),
      });

      return json(res, 200, {
        ok: true,
        videoId,
        page,
        audioFile: path.basename(audioFile),
        duration,
        cached,
        totalDuration: detectResult.totalDuration,
        segments: splitResults,
        method: useLibrosa ? "librosa" : "silence",
        musicFrames: detectResult.musicFrames,
        speechFrames: detectResult.speechFrames,
      });
    }

    /* ---- POST /merge-full-span — 最早分轨起点 ~ 最晚分轨终点，一条整轨（原片间隙原样保留） ---- */
    if (req.method === "POST" && pathname === "/merge-full-span") {
      const body = await readBody(req);
      const { videoId: vid, page: pg } = body;
      if (!vid) return json(res, 400, { error: "Missing videoId" });

      const p = parseInt(String(pg || "1"), 10) || 1;
      const baseDir = p > 1 ? path.join(DATA_DIR, vid, `p${p}`) : path.join(DATA_DIR, vid);
      if (!fs.existsSync(baseDir)) {
        return json(res, 404, { error: "未找到该 BV 的提取目录" });
      }
      const sourceFile = fs.readdirSync(baseDir).find((f) => f.startsWith("source."));
      if (!sourceFile) {
        return json(res, 404, { error: "尚未提取完整音频，请先执行提取" });
      }
      const audioPath = path.join(baseDir, sourceFile);
      const musicDir = path.join(baseDir, "music");
      if (!fs.existsSync(musicDir)) {
        return json(res, 404, { error: "没有 music/ 分轨，请先分割歌曲" });
      }

      try {
        const result = await writeMergedFullSpanFromSource(audioPath, musicDir, p);
        console.log(`[merge-full-span] ${vid} p${p} -> ${result.file} [${result.start}–${result.end}]`);
        return json(res, 200, { ok: true, ...result });
      } catch (err) {
        return json(res, 400, { error: err.message || String(err) });
      }
    }

    /* ---- POST /merge-selected — 勾选时间上连续的多段，合并为 merged_selection.mp3 并删除原分轨 ---- */
    if (req.method === "POST" && pathname === "/merge-selected") {
      const body = await readBody(req);
      const { videoId: vid, page: pg, fileNames } = body;
      if (!vid) {
        return json(res, 400, { error: "Missing videoId" });
      }
      if (!Array.isArray(fileNames) || fileNames.length < 2) {
        return json(res, 400, { error: "请传 fileNames 数组且至少 2 项" });
      }

      const p = parseInt(String(pg || "1"), 10) || 1;
      const baseDir = p > 1 ? path.join(DATA_DIR, vid, `p${p}`) : path.join(DATA_DIR, vid);
      if (!fs.existsSync(baseDir)) {
        return json(res, 404, { error: "未找到该 BV 的提取目录" });
      }
      const sourceFile = fs.readdirSync(baseDir).find((f) => f.startsWith("source."));
      if (!sourceFile) {
        return json(res, 404, { error: "尚未提取完整音频" });
      }
      const audioPath = path.join(baseDir, sourceFile);
      const musicDir = path.join(baseDir, "music");
      if (!fs.existsSync(musicDir)) {
        return json(res, 404, { error: "没有 music/ 分轨" });
      }

      try {
        const result = await mergeSelectedConsecutiveAndDeleteFromSource(audioPath, musicDir, p, fileNames);
        console.log(`[merge-selected] ${vid} p${p} -> ${result.file}, deleted: ${result.deleted?.join(", ")}`);
        return json(res, 200, { ok: true, ...result });
      } catch (err) {
        return json(res, 400, { error: err.message || String(err) });
      }
    }

    /* ---- POST /rename-song — Update song label (file stays unchanged) ---- */
    if (req.method === "POST" && pathname === "/rename-song") {
      const body = await readBody(req);
      const { videoId: vid, fileName, newLabel, page: pg } = body;

      if (!vid || !fileName || !newLabel)
        return json(res, 400, { error: "Missing videoId, fileName, or newLabel" });

      const p = parseInt(pg, 10);
      const baseDir = (p > 1) ? path.join(DATA_DIR, vid, `p${p}`) : path.join(DATA_DIR, vid);
      const musicDir = path.join(baseDir, "music");
      if (!fs.existsSync(musicDir))
        return json(res, 404, { error: "Music directory not found" });

      const fname = fileName.replace(/^music\//, "");
      const filePath = path.join(musicDir, fname);
      if (!fs.existsSync(filePath))
        return json(res, 404, { error: "Song file not found" });

      try {
        updateMusicMetadataLabel(musicDir, fname, newLabel.trim());
        console.log(`[rename-song] ${vid}/${fname} label -> "${newLabel.trim()}"`);
        return json(res, 200, { ok: true, label: newLabel.trim() });
      } catch (err) {
        return json(res, 500, { error: `Rename failed: ${err.message}` });
      }
    }

    /* ---- POST /delete-song — Delete a song file ---- */
    if (req.method === "POST" && pathname === "/delete-song") {
      const body = await readBody(req);
      const { videoId: vid, fileName, page: pg } = body;

      if (!vid || !fileName)
        return json(res, 400, { error: "Missing videoId or fileName" });

      const p = parseInt(pg, 10);
      const baseDir = (p > 1) ? path.join(DATA_DIR, vid, `p${p}`) : path.join(DATA_DIR, vid);
      // fileName can be "music/xxx.mp3" or just "xxx.mp3"
      const filePath = path.join(baseDir, fileName);

      if (!fs.existsSync(filePath))
        return json(res, 404, { error: "File not found" });

      try {
        await fsp.unlink(filePath);
        // Update metadata
        const mDir = path.join(baseDir, "music");
        updateMusicMetadataDelete(mDir, fileName);
        console.log(`[delete-song] Deleted: ${vid}/${fileName}`);
        return json(res, 200, { ok: true });
      } catch (err) {
        return json(res, 500, { error: `Delete failed: ${err.message}` });
      }
    }

    /* ---- GET /library — List all extracted videos and their songs ---- */
    if (req.method === "GET" && pathname === "/library") {
      const library = [];

      if (!fs.existsSync(DATA_DIR)) return json(res, 200, { ok: true, videos: [] });

      for (const videoId of fs.readdirSync(DATA_DIR)) {
        const videoBase = path.join(DATA_DIR, videoId);
        if (!fs.statSync(videoBase).isDirectory()) continue;

        // Collect page directories: root (p1) + p2, p3, ...
        const pageDirs = [];
        // Check if root has source file (p1)
        const rootSource = fs.readdirSync(videoBase).find(f => f.startsWith("source."));
        if (rootSource) pageDirs.push({ page: 1, dir: videoBase });
        // Check pN subdirectories
        for (const sub of fs.readdirSync(videoBase)) {
          const m = sub.match(/^p(\d+)$/);
          if (m) {
            const subDir = path.join(videoBase, sub);
            if (fs.statSync(subDir).isDirectory()) {
              const subSource = fs.readdirSync(subDir).find(f => f.startsWith("source."));
              if (subSource) pageDirs.push({ page: parseInt(m[1], 10), dir: subDir });
            }
          }
        }

        for (const { page, dir } of pageDirs) {
          const musicDir = path.join(dir, "music");
          if (!fs.existsSync(musicDir)) continue;
          const musicFiles = fs.readdirSync(musicDir).filter(f =>
            !fs.statSync(path.join(musicDir, f)).isDirectory() && f !== "metadata.json"
          );
          if (musicFiles.length === 0) continue;

          const meta = loadMusicMetadata(musicDir);
          const info = loadVideoInfo(dir) || {};

          // Fallback extractedAt: use the earliest music file mtime if no video_info
          let fallbackTime = null;
          if (!info.extractedAt) {
            for (const f of musicFiles) {
              const st = fs.statSync(path.join(musicDir, f));
              const t = st.mtime.toISOString();
              if (!fallbackTime || t < fallbackTime) fallbackTime = t;
            }
          }

          const songs = [];
          for (const f of musicFiles) {
            const m = meta[f] || {};
            let start = m.start ?? 0;
            let end = m.end ?? 0;
            let duration = m.duration ?? 0;

            // Try to parse time from filename like [00:01:30-00:04:15] or [00_01_30-00_04_15]
            if (start === 0 && end === 0) {
              const timeMatch = f.match(/\[(\d{2})[_:](\d{2})[_:](\d{2})-(\d{2})[_:](\d{2})[_:](\d{2})\]/);
              if (timeMatch) {
                start = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3]);
                end = parseInt(timeMatch[4]) * 3600 + parseInt(timeMatch[5]) * 60 + parseInt(timeMatch[6]);
                duration = Math.round((end - start) * 100) / 100;
              }
            }

            // Fallback: get actual duration from the audio file via ffprobe
            if (duration === 0) {
              duration = await getAudioDuration(path.join(musicDir, f));
            }

            songs.push({
              file: f,
              label: m.label || f.replace(/\.[^.]+$/, ""),
              start,
              end,
              duration,
              index: m.index ?? 0,
              page: m.page ?? page,
              originalName: m.originalName || f,
              renamedAt: m.renamedAt || null,
            });
          }

          library.push({
            bvid: videoId,
            page,
            url: info.url || `https://www.bilibili.com/video/${videoId}${page > 1 ? "?p=" + page : ""}`,
            extractedAt: info.extractedAt || fallbackTime,
            songs,
          });
        }
      }

      // Sort by extractedAt descending (newest first)
      library.sort((a, b) => {
        if (!a.extractedAt) return 1;
        if (!b.extractedAt) return -1;
        return b.extractedAt.localeCompare(a.extractedAt);
      });

      return json(res, 200, { ok: true, videos: library });
    }

    /* ---- GET /download/:videoId/... — Download/stream audio file (supports music/ subdir) ---- */
    /* Supports HTTP Range requests so the browser <audio> element can seek. */
    if (req.method === "GET" && pathname.startsWith("/download/")) {
      const parts = pathname.replace("/download/", "").split("/");
      const videoId = parts[0];
      const filename = decodeURIComponent(parts.slice(1).join("/"));
      const filePath = path.join(DATA_DIR, videoId, filename);

      if (!fs.existsSync(filePath)) return json(res, 404, { error: "File not found" });

      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const ext = path.extname(filePath).toLowerCase();
      const mimeMap = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg" };
      const mime = mimeMap[ext] || "application/octet-stream";

      const rangeHeader = req.headers.range;
      if (rangeHeader) {
        // Parse Range header, e.g. "bytes=32324-"
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          const start = parseInt(match[1], 10);
          const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
          const chunkSize = end - start + 1;

          res.writeHead(206, {
            "Content-Type": mime,
            "Content-Length": chunkSize,
            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
            "Accept-Ranges": "bytes",
            "Content-Disposition": `inline; filename="${encodeURIComponent(filename)}"`,
            "Access-Control-Allow-Origin": "*",
          });
          fs.createReadStream(filePath, { start, end }).pipe(res);
        } else {
          // Malformed Range header — send full file
          res.writeHead(200, {
            "Content-Type": mime,
            "Content-Length": fileSize,
            "Accept-Ranges": "bytes",
            "Content-Disposition": `inline; filename="${encodeURIComponent(filename)}"`,
            "Access-Control-Allow-Origin": "*",
          });
          fs.createReadStream(filePath).pipe(res);
        }
      } else {
        // No Range header — send full file
        res.writeHead(200, {
          "Content-Type": mime,
          "Content-Length": fileSize,
          "Accept-Ranges": "bytes",
          "Content-Disposition": `inline; filename="${encodeURIComponent(filename)}"`,
          "Access-Control-Allow-Origin": "*",
        });
        fs.createReadStream(filePath).pipe(res);
      }
      return;
    }

    /* ---- GET /check — Health check & dependency check ---- */
    if (req.method === "GET" && (pathname === "/check" || pathname === "/")) {
      let ytdlpOk = false;
      let ffmpegOk = false;
      let pythonOk = false;
      let librosaOk = false;

      try {
        await execFileAsync("yt-dlp", ["--version"], { timeout: 5000 });
        ytdlpOk = true;
      } catch {}

      try {
        await execFileAsync("ffmpeg", ["-version"], { timeout: 5000 });
        ffmpegOk = true;
      } catch {}

      try {
        await execFileAsync("python", ["-c", "import librosa; print('ok')"], { timeout: 15000 });
        pythonOk = true;
        librosaOk = true;
      } catch {
        try {
          await execFileAsync("python", ["--version"], { timeout: 5000 });
          pythonOk = true;
        } catch {}
      }

      const allOk = ytdlpOk && ffmpegOk;
      return json(res, 200, {
        ok: allOk,
        ytdlp: ytdlpOk,
        ffmpeg: ffmpegOk,
        python: pythonOk,
        librosa: librosaOk,
        message: allOk
          ? (librosaOk
            ? "All dependencies ready (smart music detection enabled)"
            : "Core dependencies ready (smart music detection unavailable — install librosa)")
          : `Missing: ${[!ytdlpOk && "yt-dlp", !ffmpegOk && "ffmpeg"].filter(Boolean).join(", ")}`,
      });
    }

    /* ---- POST /cleanup/:videoId — Delete extracted files ---- */
    if (req.method === "POST" && pathname.startsWith("/cleanup/")) {
      const videoId = pathname.replace("/cleanup/", "");
      const dir = path.join(DATA_DIR, videoId);
      if (fs.existsSync(dir)) {
        await fsp.rm(dir, { recursive: true, force: true });
      }
      return json(res, 200, { ok: true });
    }

    // 404
    json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error("[server error]", err);
    json(res, 500, { error: err.message || "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`🎵 Audio Extractor Server running on http://127.0.0.1:${PORT}`);
  console.log(`   Data directory: ${DATA_DIR}`);
  console.log(`   Checking dependencies...`);

  // Quick dependency check on startup
  Promise.all([
    execFileAsync("yt-dlp", ["--version"], { timeout: 5000 }).then(
      (r) => console.log(`   ✅ yt-dlp ${r.stdout.trim()}`),
      () => console.warn("   ❌ yt-dlp not found! Install: winget install yt-dlp"),
    ),
    execFileAsync("ffmpeg", ["-version"], { timeout: 5000 }).then(
      (r) => console.log(`   ✅ ffmpeg ${r.stdout.split("\n")[0]}`),
      () => console.warn("   ❌ ffmpeg not found! Install: winget install ffmpeg"),
    ),
    execFileAsync("python", ["-c", "import librosa; print(librosa.__version__)"], { timeout: 15000 }).then(
      (r) => console.log(`   ✅ python + librosa ${r.stdout.trim()} (smart music detection enabled)`),
      () => console.warn("   ⚠️  python/librosa not available — smart music detection disabled\n       Install: pip install librosa soundfile"),
    ),
  ]);
});
