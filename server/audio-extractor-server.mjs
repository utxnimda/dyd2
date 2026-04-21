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

/** Get video directory (each video gets its own folder) */
function videoDir(videoId) {
  const dir = path.join(DATA_DIR, videoId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Sanitize filename */
function sanitize(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 100);
}

/* ------------------------------------------------------------------ */
/*  Core: Extract audio from Bilibili video                           */
/* ------------------------------------------------------------------ */

/**
 * Extract audio from a Bilibili video URL using yt-dlp.
 * Returns the path to the extracted audio file.
 */
async function extractAudio(url, videoId) {
  const dir = videoDir(videoId);
  const outputTemplate = path.join(dir, "source.%(ext)s");

  // Check if already extracted
  const existing = fs.readdirSync(dir).find((f) => f.startsWith("source."));
  if (existing) {
    return { file: path.join(dir, existing), cached: true };
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
  return { file: path.join(dir, files[0]), cached: false };
}

/* ------------------------------------------------------------------ */
/*  Core: Detect song segments via silence detection                  */
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
async function splitAudio(audioPath, segments, videoId) {
  const dir = videoDir(videoId);
  const results = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const label = seg.label || `segment_${String(i + 1).padStart(2, "0")}`;
    const outFile = path.join(dir, `${sanitize(label)}.mp3`);

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
        file: path.basename(outFile),
        label,
        start: seg.start,
        end: seg.end,
        duration: Math.round((seg.end - seg.start) * 100) / 100,
      });
    } catch (err) {
      console.error(`[split] Failed segment ${i}:`, err.message);
    }
  }

  return results;
}

/* ------------------------------------------------------------------ */
/*  Core: Get audio duration                                          */
/* ------------------------------------------------------------------ */

async function getAudioDuration(audioPath) {
  try {
    const { stdout } = await execFileAsync("ffmpeg", [
      "-i", audioPath,
      "-f", "null", "-",
    ], { timeout: 30_000 }).catch(() => ({ stdout: "" }));

    // ffprobe approach
    const { stdout: probeOut } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      audioPath,
    ], { timeout: 30_000 }).catch(() => ({ stdout: "0" }));

    return parseFloat(probeOut) || 0;
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

      if (!videoUrl) return json(res, 400, { error: "Missing url" });

      console.log(`[extract] Starting: ${videoUrl} (id=${videoId})`);
      const { file, cached } = await extractAudio(videoUrl, videoId);
      const duration = await getAudioDuration(file);

      return json(res, 200, {
        ok: true,
        videoId,
        audioFile: path.basename(file),
        cached,
        duration,
      });
    }

    /* ---- POST /detect — Detect song segments ---- */
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
        const stat = fs.statSync(path.join(dir, f));
        return { name: f, size: stat.size, mtime: stat.mtime.toISOString() };
      });

      return json(res, 200, { ok: true, files });
    }

    /* ---- GET /download/:videoId/:filename — Download/stream audio file ---- */
    if (req.method === "GET" && pathname.startsWith("/download/")) {
      const parts = pathname.replace("/download/", "").split("/");
      const videoId = parts[0];
      const filename = decodeURIComponent(parts.slice(1).join("/"));
      const filePath = path.join(videoDir(videoId), filename);

      if (!fs.existsSync(filePath)) return json(res, 404, { error: "File not found" });

      const stat = fs.statSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mimeMap = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg" };
      const mime = mimeMap[ext] || "application/octet-stream";

      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": stat.size,
        "Content-Disposition": `inline; filename="${encodeURIComponent(filename)}"`,
        "Access-Control-Allow-Origin": "*",
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    /* ---- GET /check — Health check & dependency check ---- */
    if (req.method === "GET" && (pathname === "/check" || pathname === "/")) {
      let ytdlpOk = false;
      let ffmpegOk = false;

      try {
        await execFileAsync("yt-dlp", ["--version"], { timeout: 5000 });
        ytdlpOk = true;
      } catch {}

      try {
        await execFileAsync("ffmpeg", ["-version"], { timeout: 5000 });
        ffmpegOk = true;
      } catch {}

      return json(res, 200, {
        ok: ytdlpOk && ffmpegOk,
        ytdlp: ytdlpOk,
        ffmpeg: ffmpegOk,
        message: ytdlpOk && ffmpegOk
          ? "All dependencies ready"
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
  ]);
});
