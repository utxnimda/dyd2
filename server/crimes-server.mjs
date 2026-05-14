/**
 * Crimes Server — "细数宝罪"
 *
 * Provides APIs for:
 * 1. Fetching Netease Cloud Music playlists
 * 2. Fetching QQ Music playlists
 * 3. Song voting (like/dislike)
 * 4. Wishlist management (recommend songs from playlist)
 *
 * Usage: node server/crimes-server.mjs
 * Default port: 8790
 */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data", "crimes");
const PORT = parseInt(process.env.CRIMES_PORT || "8790", 10);

// Netease Cloud Music API base
// Priority: env var > self-hosted > direct official API
const NETEASE_API_BASE = process.env.NETEASE_API || "";

// Common headers for Netease official API requests
const NETEASE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Referer": "https://music.163.com/",
  "Origin": "https://music.163.com",
  "Content-Type": "application/x-www-form-urlencoded",
};

// Common headers for QQ Music API requests
const QQ_MUSIC_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Referer": "https://y.qq.com/",
  "Origin": "https://y.qq.com",
};

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
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

/* ------------------------------------------------------------------ */
/*  Data persistence — votes & wishlist stored as JSON files           */
/* ------------------------------------------------------------------ */

const VOTES_FILE = path.join(DATA_DIR, "votes.json");
const WISHLIST_FILE = path.join(DATA_DIR, "wishlist.json");
const PLAYLISTS_CACHE_DIR = path.join(DATA_DIR, "playlists");

if (!fs.existsSync(PLAYLISTS_CACHE_DIR)) {
  fs.mkdirSync(PLAYLISTS_CACHE_DIR, { recursive: true });
}

/** Load votes data: { [songId]: { likes: number, dislikes: number, voters: { [voter]: "like"|"dislike" } } } */
function loadVotes() {
  try {
    if (fs.existsSync(VOTES_FILE)) {
      return JSON.parse(fs.readFileSync(VOTES_FILE, "utf-8"));
    }
  } catch { /* ignore */ }
  return {};
}

function saveVotes(votes) {
  fs.writeFileSync(VOTES_FILE, JSON.stringify(votes, null, 2), "utf-8");
}

/**
 * Wishlist data structure:
 * { [songId]: { count: number, songName: string, artist: string, recommenders: [{ name, at }] } }
 * recommenders list is capped at 1000 entries.
 */
function loadWishlist() {
  try {
    if (fs.existsSync(WISHLIST_FILE)) {
      return JSON.parse(fs.readFileSync(WISHLIST_FILE, "utf-8"));
    }
  } catch { /* ignore */ }
  return {};
}

function saveWishlist(wishlist) {
  fs.writeFileSync(WISHLIST_FILE, JSON.stringify(wishlist, null, 2), "utf-8");
}

/* ------------------------------------------------------------------ */
/*  Data migration — add platform prefix to old song IDs              */
/* ------------------------------------------------------------------ */

/**
 * Migrate old data keys from plain songId to "platform:songId" format.
 * - Pure numeric keys → "netease:xxx" (old data was all from Netease)
 * - Alphanumeric keys (QQ Music songmid) → "qq:xxx"
 * - Keys already containing ":" → skip (already migrated)
 */
function migrateDataKeys() {
  let changed = false;

  // Migrate votes
  const votes = loadVotes();
  const migratedVotes = {};
  for (const [key, value] of Object.entries(votes)) {
    if (key.includes(":")) {
      migratedVotes[key] = value;
    } else if (/^\d+$/.test(key)) {
      migratedVotes[`netease:${key}`] = value;
      changed = true;
    } else {
      // Alphanumeric (QQ Music songmid like "0002zMFX3VfcbE")
      migratedVotes[`qq:${key}`] = value;
      changed = true;
    }
  }
  if (changed) {
    saveVotes(migratedVotes);
    console.log(`[crimes] Migrated votes: ${Object.keys(votes).length} → ${Object.keys(migratedVotes).length} entries`);
  }

  // Migrate wishlist
  changed = false;
  const wishlist = loadWishlist();
  const migratedWishlist = {};
  for (const [key, value] of Object.entries(wishlist)) {
    if (key.includes(":")) {
      migratedWishlist[key] = value;
    } else if (/^\d+$/.test(key)) {
      migratedWishlist[`netease:${key}`] = value;
      changed = true;
    } else {
      migratedWishlist[`qq:${key}`] = value;
      changed = true;
    }
  }
  if (changed) {
    saveWishlist(migratedWishlist);
    console.log(`[crimes] Migrated wishlist: ${Object.keys(wishlist).length} → ${Object.keys(migratedWishlist).length} entries`);
  }
}

// Run migration on startup
migrateDataKeys();

/* ------------------------------------------------------------------ */
/*  Netease Cloud Music API helpers                                   */
/* ------------------------------------------------------------------ */

/**
 * Fetch playlist detail — tries third-party API first (if configured),
 * falls back to Netease official web API.
 */
async function fetchPlaylistDetail(playlistId) {
  const cacheFile = path.join(PLAYLISTS_CACHE_DIR, `${playlistId}.json`);

  // Check cache (valid for 10 minutes)
  if (fs.existsSync(cacheFile)) {
    const stat = fs.statSync(cacheFile);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < 10 * 60 * 1000) {
      return JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    }
  }

  let data;

  if (NETEASE_API_BASE) {
    // Use third-party NeteaseCloudMusicApi
    const url = `${NETEASE_API_BASE}/playlist/detail?id=${playlistId}`;
    console.log(`[crimes] Fetching playlist (3rd-party): ${url}`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Netease API error: ${resp.status}`);
    data = await resp.json();
  } else {
    // Use official Netease web API directly
    const url = `https://music.163.com/api/v6/playlist/detail?id=${playlistId}&n=100000&s=0`;
    console.log(`[crimes] Fetching playlist (official): ${url}`);
    const resp = await fetch(url, {
      headers: NETEASE_HEADERS,
    });
    if (!resp.ok) throw new Error(`Netease official API error: ${resp.status}`);
    data = await resp.json();
  }

  if (data.code !== 200) throw new Error(`Netease API code: ${data.code}`);

  const playlist = data.playlist;
  if (!playlist) throw new Error("No playlist data returned");

  // Official API may return trackIds without full track info, or only partial tracks.
  // When tracks count is less than trackIds count, fetch ALL tracks by IDs.
  let tracks = playlist.tracks || [];
  const trackIds = (playlist.trackIds || []).map((t) => t.id);
  if (trackIds.length > 0 && tracks.length < trackIds.length) {
    console.log(`[crimes] tracks=${tracks.length}, trackIds=${trackIds.length}, fetching all by IDs...`);
    const fetched = await fetchTrackDetails(trackIds);
    if (fetched.length > tracks.length) {
      tracks = fetched;
    }
  }

  const result = {
    id: playlist.id,
    name: playlist.name,
    description: playlist.description || "",
    coverUrl: playlist.coverImgUrl || "",
    trackCount: playlist.trackCount || tracks.length,
    playCount: playlist.playCount || 0,
    tracks: tracks.map((t) => ({
      id: t.id,
      name: t.name,
      artist: (t.ar || t.artists || []).map((a) => a.name).join(" / "),
      album: t.al?.name || t.album?.name || "",
      albumCover: t.al?.picUrl || t.album?.picUrl || "",
      duration: t.dt || t.duration || 0, // milliseconds
    })),
    fetchedAt: new Date().toISOString(),
  };

  // Save cache
  fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), "utf-8");
  return result;
}

/** Fetch track details by IDs (batch, max 200 per request for reliability) */
async function fetchTrackDetails(trackIds) {
  const allTracks = [];
  // Use smaller batch size for official API to avoid request size limits
  const batchSize = NETEASE_API_BASE ? 500 : 200;

  for (let i = 0; i < trackIds.length; i += batchSize) {
    const batch = trackIds.slice(i, i + batchSize);
    const ids = batch.join(",");

    try {
      let data;
      if (NETEASE_API_BASE) {
        const url = `${NETEASE_API_BASE}/song/detail?ids=${ids}`;
        const resp = await fetch(url);
        if (resp.ok) {
          data = await resp.json();
          if (data.songs) allTracks.push(...data.songs);
        }
      } else {
        // Official API: use POST with c parameter (more reliable for large batches)
        const c = JSON.stringify(batch.map((id) => ({ id })));
        const url = `https://music.163.com/api/v3/song/detail`;
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            ...NETEASE_HEADERS,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: `c=${encodeURIComponent(c)}`,
        });
        if (resp.ok) {
          data = await resp.json();
          if (data.songs) allTracks.push(...data.songs);
        }
      }
      console.log(`[crimes] Fetched batch ${Math.floor(i / batchSize) + 1}: ${batch.length} IDs → ${data?.songs?.length || 0} songs`);
    } catch (err) {
      console.error(`[crimes] fetchTrackDetails batch error:`, err.message);
    }
  }

  console.log(`[crimes] Total fetched: ${allTracks.length} / ${trackIds.length}`);
  return allTracks;
}

/** Get song play URL from Netease (resolve the actual audio URL server-side) */
async function resolveAudioUrl(songId) {
  if (NETEASE_API_BASE) {
    try {
      const url = `${NETEASE_API_BASE}/song/url?id=${songId}`;
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        if (data.code === 200 && data.data?.[0]?.url) {
          return data.data[0].url;
        }
      }
    } catch { /* fall through to official */ }
  }

  // Official outer URL — follow redirects to get the real audio URL
  const outerUrl = `https://music.163.com/song/media/outer/url?id=${songId}.mp3`;
  try {
    const resp = await fetch(outerUrl, {
      headers: NETEASE_HEADERS,
      redirect: "follow",
    });
    // The final URL after redirects is the actual audio
    if (resp.ok || resp.status === 302 || resp.status === 301) {
      return resp.url || outerUrl;
    }
  } catch { /* ignore */ }

  return outerUrl;
}

/* ------------------------------------------------------------------ */
/*  QQ Music API helpers                                              */
/* ------------------------------------------------------------------ */

/**
 * Fetch QQ Music playlist detail using the public FCGI API.
 * QQ Music uses a different ID system — the disstid (playlist ID).
 */
async function fetchQQPlaylistDetail(playlistId) {
  const cacheFile = path.join(PLAYLISTS_CACHE_DIR, `qq_${playlistId}.json`);

  // Check cache (valid for 10 minutes)
  if (fs.existsSync(cacheFile)) {
    const stat = fs.statSync(cacheFile);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < 10 * 60 * 1000) {
      return JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    }
  }

  // Use QQ Music's public FCGI interface
  const reqData = {
    comm: {
      ct: 24,
      cv: 0,
    },
    playlist: {
      module: "music.srfDissInfo.aiDissInfo",
      method: "uniform_get_Ede",
      param: {
        disstid: Number(playlistId),
        userinfo: 1,
        tag: 1,
      },
    },
  };

  const url = `https://u.y.qq.com/cgi-bin/musicu.fcg?data=${encodeURIComponent(JSON.stringify(reqData))}`;
  console.log(`[crimes] Fetching QQ Music playlist: ${playlistId}`);

  const resp = await fetch(url, { headers: QQ_MUSIC_HEADERS });
  if (!resp.ok) throw new Error(`QQ Music API error: ${resp.status}`);

  const data = await resp.json();
  const dissInfo = data?.playlist?.data;
  if (!dissInfo) {
    // Try alternative API format
    return await fetchQQPlaylistDetailAlt(playlistId, cacheFile);
  }

  const result = buildQQPlaylistResult(dissInfo);

  // Save cache
  fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), "utf-8");
  return result;
}

/** Alternative QQ Music API (older FCGI endpoint) */
async function fetchQQPlaylistDetailAlt(playlistId, cacheFile) {
  const url = `https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&new_format=1&disstid=${playlistId}&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`;
  console.log(`[crimes] Fetching QQ Music playlist (alt): ${playlistId}`);

  const resp = await fetch(url, {
    headers: {
      ...QQ_MUSIC_HEADERS,
      "Referer": `https://y.qq.com/n/ryqq/playlist/${playlistId}`,
    },
  });
  if (!resp.ok) throw new Error(`QQ Music alt API error: ${resp.status}`);

  const data = await resp.json();
  const cdlist = data?.cdlist;
  if (!cdlist || cdlist.length === 0) throw new Error("QQ Music: No playlist data returned");

  const cd = cdlist[0];
  const result = {
    id: cd.disstid || playlistId,
    name: cd.dissname || "QQ音乐歌单",
    description: cd.desc || "",
    coverUrl: cd.logo || cd.dir_pic_url2 || "",
    trackCount: cd.songnum || cd.songlist?.length || 0,
    playCount: cd.visitnum || 0,
    source: "qq",
    tracks: (cd.songlist || []).map((t) => ({
      id: t.songmid || t.mid || t.id,
      name: t.songname || t.name || "",
      artist: (t.singer || []).map((s) => s.name).join(" / "),
      album: t.albumname || t.album?.name || "",
      albumCover: t.albummid
        ? `https://y.qq.com/music/photo_new/T002R300x300M000${t.albummid}.jpg`
        : "",
      duration: (t.interval || 0) * 1000, // QQ Music uses seconds, convert to ms
    })),
    fetchedAt: new Date().toISOString(),
  };

  // Save cache
  if (cacheFile) {
    fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), "utf-8");
  }
  return result;
}

/** Build standardized playlist result from QQ Music dissInfo */
function buildQQPlaylistResult(dissInfo) {
  const songlist = dissInfo.songlist || dissInfo.songList || [];
  return {
    id: dissInfo.disstid || dissInfo.id || "",
    name: dissInfo.dissname || dissInfo.title || "QQ音乐歌单",
    description: dissInfo.desc || dissInfo.introduction || "",
    coverUrl: dissInfo.logo || dissInfo.picurl || dissInfo.dir_pic_url2 || "",
    trackCount: dissInfo.songnum || dissInfo.total_song_num || songlist.length,
    playCount: dissInfo.visitnum || dissInfo.visit_num || 0,
    source: "qq",
    tracks: songlist.map((t) => {
      const songInfo = t.songInfo || t;
      const mid = songInfo.mid || songInfo.songmid || songInfo.id;
      const singers = songInfo.singer || [];
      const albumMid = songInfo.album?.mid || songInfo.albummid || "";
      return {
        id: mid,
        name: songInfo.title || songInfo.name || songInfo.songname || "",
        artist: singers.map((s) => s.name || s.title).join(" / "),
        album: songInfo.album?.title || songInfo.album?.name || songInfo.albumname || "",
        albumCover: albumMid
          ? `https://y.qq.com/music/photo_new/T002R300x300M000${albumMid}.jpg`
          : "",
        duration: (songInfo.interval || 0) * 1000,
      };
    }),
    fetchedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/*  HTTP Server                                                       */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    /* ---- GET /playlist/:id — Fetch Netease playlist ---- */
    const playlistMatch = pathname.match(/^\/playlist\/(\d+)$/);
    if (req.method === "GET" && playlistMatch) {
      const playlistId = playlistMatch[1];
      const playlist = await fetchPlaylistDetail(playlistId);
      return json(res, 200, { ok: true, playlist });
    }

    /* ---- GET /qq-playlist/:id — Fetch QQ Music playlist ---- */
    const qqPlaylistMatch = pathname.match(/^\/qq-playlist\/([\w]+)$/);
    if (req.method === "GET" && qqPlaylistMatch) {
      const playlistId = qqPlaylistMatch[1];
      const playlist = await fetchQQPlaylistDetail(playlistId);
      return json(res, 200, { ok: true, playlist });
    }

    /* ---- GET /song-url/:id — Get playable URL for a song ---- */
    const songUrlMatch = pathname.match(/^\/song-url\/(\d+)$/);
    if (req.method === "GET" && songUrlMatch) {
      const songId = songUrlMatch[1];
      const songUrl = await resolveAudioUrl(songId);
      if (!songUrl) return json(res, 404, { ok: false, error: "Song URL not available" });
      return json(res, 200, { ok: true, url: songUrl });
    }

    /* ---- GET /audio-proxy/:id — Proxy audio stream to bypass CORS ---- */
    const audioProxyMatch = pathname.match(/^\/audio-proxy\/(\d+)$/);
    if (req.method === "GET" && audioProxyMatch) {
      const songId = audioProxyMatch[1];
      try {
        const audioUrl = await resolveAudioUrl(songId);
        if (!audioUrl) {
          res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
          return res.end("Not found");
        }

        // Fetch the audio from Netease and pipe it to the client
        const audioResp = await fetch(audioUrl, {
          headers: {
            "User-Agent": NETEASE_HEADERS["User-Agent"],
            "Referer": "https://music.163.com/",
          },
          redirect: "follow",
        });

        if (!audioResp.ok) {
          res.writeHead(audioResp.status, { "Access-Control-Allow-Origin": "*" });
          return res.end("Audio fetch failed");
        }

        const contentType = audioResp.headers.get("content-type") || "audio/mpeg";
        const contentLength = audioResp.headers.get("content-length");

        const headers = {
          "Content-Type": contentType,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=3600",
        };
        if (contentLength) headers["Content-Length"] = contentLength;

        res.writeHead(200, headers);

        // Stream the audio body
        const reader = audioResp.body.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { res.end(); return; }
            if (!res.write(value)) {
              await new Promise((r) => res.once("drain", r));
            }
          }
        };
        await pump();
      } catch (err) {
        console.error(`[crimes] Audio proxy error for ${songId}:`, err.message);
        if (!res.headersSent) {
          res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
        }
        res.end("Proxy error");
      }
      return;
    }

    /* ---- GET /votes — Get all votes ---- */
    if (req.method === "GET" && pathname === "/votes") {
      const votes = loadVotes();
      return json(res, 200, { ok: true, votes });
    }

    /* ---- POST /vote — Vote on a song ---- */
    if (req.method === "POST" && pathname === "/vote") {
      const body = await readBody(req);
      const { songId, voter, action } = body; // action: "like" | "dislike" | "cancel"

      if (!songId || !voter) return json(res, 400, { error: "Missing songId or voter" });
      if (!["like", "dislike", "cancel"].includes(action)) {
        return json(res, 400, { error: "Invalid action (like/dislike/cancel)" });
      }

      const votes = loadVotes();
      const songIdStr = String(songId);

      if (!votes[songIdStr]) {
        votes[songIdStr] = { likes: 0, dislikes: 0, voters: {} };
      }

      const entry = votes[songIdStr];
      const prevVote = entry.voters[voter];

      // Remove previous vote count
      if (prevVote === "like") entry.likes = Math.max(0, entry.likes - 1);
      if (prevVote === "dislike") entry.dislikes = Math.max(0, entry.dislikes - 1);

      // Apply new vote
      if (action === "cancel") {
        delete entry.voters[voter];
      } else {
        entry.voters[voter] = action;
        if (action === "like") entry.likes++;
        if (action === "dislike") entry.dislikes++;
      }

      saveVotes(votes);
      return json(res, 200, { ok: true, song: { songId: songIdStr, ...entry } });
    }

    /* ---- GET /wishlist — Get all wishlist data ---- */
    if (req.method === "GET" && pathname === "/wishlist") {
      const wishlist = loadWishlist();
      return json(res, 200, { ok: true, wishlist });
    }

    /* ---- POST /wishlist/recommend — Recommend a song (increment count + add recommender) ---- */
    if (req.method === "POST" && pathname === "/wishlist/recommend") {
      const body = await readBody(req);
      const { songId, songName, artist, recommender } = body;

      if (!songId || !songName) return json(res, 400, { error: "Missing songId or songName" });
      if (!recommender) return json(res, 400, { error: "Missing recommender" });

      const wishlist = loadWishlist();
      const key = String(songId);

      if (!wishlist[key]) {
        wishlist[key] = { count: 0, songName, artist: artist || "", recommenders: [] };
      }

      // Increment count
      wishlist[key].count++;
      // Update song info in case it changed
      wishlist[key].songName = songName;
      if (artist) wishlist[key].artist = artist;

      // Add recommender (cap at 1000)
      wishlist[key].recommenders.push({ name: recommender, at: new Date().toISOString() });
      if (wishlist[key].recommenders.length > 1000) {
        wishlist[key].recommenders = wishlist[key].recommenders.slice(-1000);
      }

      saveWishlist(wishlist);
      return json(res, 200, { ok: true, song: { songId: key, ...wishlist[key] } });
    }

    /* ---- 404 ---- */
    return json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(`[crimes] Error:`, err);
    return json(res, 500, { error: err.message || "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`[crimes-server] 🎵 细数宝罪 server running on http://localhost:${PORT}`);
});
