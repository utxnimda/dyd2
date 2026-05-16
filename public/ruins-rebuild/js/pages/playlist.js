(function () {
  var CFG = window.JUKEBOX_CONFIG || {};
  var supa = window.RuinsAnonRest.wrap(CFG);
  var SUPABASE_URL = supa.base;
  var SUPABASE_KEY = supa.anonKey;
  var useCloud = supa.isReady();

  var STORAGE_VISITOR = "jukebox_visitor_id";
  var STORAGE_LOCAL = "jukebox_local_state_v1";
  var lastSongPickAt = {};
  var playlistStatusTimer = null;

  function pickNotifyWebhookUrl() {
    return String((CFG || {}).notifyPickWebhookUrl || "").trim();
  }

  /** 点歌上报成功后调用：用 sendBeacon / fetch 发 application/x-www-form-urlencoded，便于 Zapier 等跨域接收 */
  function notifyPickToAdminWebhook(song, visitorId) {
    var url = pickNotifyWebhookUrl();
    if (!url) return;
    var p = new URLSearchParams();
    p.set("event", "song_pick");
    p.set("song_id", String(song.id || ""));
    p.set("song_title", String(song.title || ""));
    p.set("song_artist", String(song.artist || ""));
    p.set("visitor_id", String(visitorId || ""));
    p.set("reported_at", new Date().toISOString());
    try {
      if (typeof navigator !== "undefined" && navigator.sendBeacon) {
        if (navigator.sendBeacon(url, p)) return;
      }
    } catch (e1) {}
    try {
      fetch(url, {
        method: "POST",
        body: p,
        keepalive: true,
        mode: "cors",
      }).catch(function () {});
    } catch (e2) {}
  }

  var SAMPLE_SONGS = window.RuinsPlaylistSamples.buildSampleSongs();
  function getVisitorId() {
    try {
      var v = localStorage.getItem(STORAGE_VISITOR);
      if (v && v.length >= 16) return v;
      v = crypto.randomUUID();
      localStorage.setItem(STORAGE_VISITOR, v);
      return v;
    } catch (e) {
      return "guest-" + String(Date.now());
    }
  }

  function readLocalState() {
    try {
      var raw = localStorage.getItem(STORAGE_LOCAL);
      if (!raw) return { likeCount: {}, liked: {}, comments: {} };
      var o = JSON.parse(raw);
      return {
        likeCount: o.likeCount || {},
        liked: o.liked || {},
        comments: o.comments || {},
      };
    } catch (e) {
      return { likeCount: {}, liked: {}, comments: {} };
    }
  }

  function writeLocalState(state) {
    try {
      localStorage.setItem(STORAGE_LOCAL, JSON.stringify(state));
    } catch (e) {}
  }

  async function sbSelect(table, query) {
    var q = query ? "?" + query : "";
    var res = await supa.fetchRest(table + q);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async function sbRpc(name, payload) {
    var res = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async function sbInsert(table, row) {
    var res = await supa.fetchRest(table, {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(row),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async function loadSongsCloud() {
    var rows = await sbSelect("songs", "select=*&order=sort_order.asc");
    return rows.map(function (r) {
      return {
        id: r.id,
        title: r.title,
        artist: r.artist,
        note: r.note || "",
        link_url: r.link_url || "",
        sort_order: r.sort_order,
      };
    });
  }

  async function loadEngagementCloud(songIds, visitorId) {
    if (!songIds.length) {
      return { counts: {}, liked: {}, commentsBySong: {} };
    }

    var inList = "(" + songIds.join(",") + ")";
    var likes = await sbSelect("song_likes", "select=song_id,visitor_id&song_id=in." + inList);

    var counts = {};
    var liked = {};
    for (var i = 0; i < likes.length; i++) {
      var row = likes[i];
      counts[row.song_id] = (counts[row.song_id] || 0) + 1;
      if (row.visitor_id === visitorId) liked[row.song_id] = true;
    }

    var comments = await sbSelect(
      "song_comments",
      "select=id,song_id,author,body,created_at&song_id=in." + inList + "&order=created_at.desc"
    );

    var commentsBySong = {};
    for (var j = 0; j < comments.length; j++) {
      var c = comments[j];
      if (!commentsBySong[c.song_id]) commentsBySong[c.song_id] = [];
      commentsBySong[c.song_id].push({
        id: c.id,
        author: c.author,
        body: c.body,
        created_at: c.created_at,
      });
    }

    for (var k = 0; k < songIds.length; k++) {
      var sid = songIds[k];
      if (!counts[sid]) counts[sid] = 0;
      if (!commentsBySong[sid]) commentsBySong[sid] = [];
    }

    return { counts: counts, liked: liked, commentsBySong: commentsBySong };
  }

  function loadEngagementLocal(songIds) {
    var st = readLocalState();
    var counts = {};
    var liked = {};
    var commentsBySong = {};

    for (var i = 0; i < songIds.length; i++) {
      var sid = songIds[i];
      counts[sid] = typeof st.likeCount[sid] === "number" ? st.likeCount[sid] : 0;
      liked[sid] = Boolean(st.liked[sid]);
      commentsBySong[sid] = Array.isArray(st.comments[sid]) ? st.comments[sid].slice() : [];
    }

    return { counts: counts, liked: liked, commentsBySong: commentsBySong };
  }

  function toggleLikeLocal(songId) {
    var st = readLocalState();
    var had = Boolean(st.liked[songId]);
    var n = typeof st.likeCount[songId] === "number" ? st.likeCount[songId] : 0;

    if (had) {
      st.liked[songId] = false;
      st.likeCount[songId] = Math.max(0, n - 1);
    } else {
      st.liked[songId] = true;
      st.likeCount[songId] = n + 1;
    }

    writeLocalState(st);
    return { liked: !had, count: st.likeCount[songId] };
  }

  function addCommentLocal(songId, author, body) {
    var st = readLocalState();
    if (!st.comments[songId]) st.comments[songId] = [];
    var entry = {
      id: crypto.randomUUID(),
      author: author,
      body: body,
      created_at: new Date().toISOString(),
    };
    st.comments[songId].unshift(entry);
    writeLocalState(st);
    return entry;
  }

  function setStatus(msg) {
    var node = RuinsDom.qs("#data-status");
    if (node) node.textContent = msg;
  }

  function playlistStatusHint() {
    if (useCloud) {
      var s =
        "已连接云端：点赞与评论对所有访客可见。点击歌曲主体可上报点歌意向（后台「点歌上报」可见）。";
      if (pickNotifyWebhookUrl()) {
        s += " 已配置 notifyPickWebhookUrl，上报后将尝试通过 Webhook 通知管理员（如发邮件）。";
      }
      return s;
    }
    return "本地演示模式：点赞与评论仅存本机。填写 config.js 启用云端后，点歌上报才会送达管理员。";
  }

  function flashPlaylistStatus(msg, ms) {
    var node = RuinsDom.qs("#data-status");
    if (!node) return;
    if (playlistStatusTimer) clearTimeout(playlistStatusTimer);
    node.textContent = msg;
    playlistStatusTimer = setTimeout(function () {
      playlistStatusTimer = null;
      node.textContent = playlistStatusHint();
    }, ms || 3200);
  }

  function closeAllPlaylistCommentPanels() {
    var list = RuinsDom.qs("#song-list");
    if (!list) return;
    var panels = list.querySelectorAll(".comments-panel");
    var toggles = list.querySelectorAll(".btn-toggle-comments");
    for (var i = 0; i < panels.length; i++) {
      panels[i].classList.add("hidden");
    }
    for (var j = 0; j < toggles.length; j++) {
      toggles[j].setAttribute("aria-expanded", "false");
    }
  }

  function renderComments(listEl, items) {
    listEl.innerHTML = "";
    if (!items.length) {
      var li = document.createElement("li");
      li.className = "comment-empty";
      li.textContent = "还没有评论，来抢沙发吧。";
      listEl.appendChild(li);
      return;
    }

    for (var i = 0; i < items.length; i++) {
      var c = items[i];
      var li = document.createElement("li");
      li.className = "comment-item";
      li.innerHTML =
        '<span class="comment-author"></span><span class="comment-time"></span>' +
        '<p class="comment-body"></p>';
      li.querySelector(".comment-author").textContent = c.author || "访客";
      li.querySelector(".comment-time").textContent = RuinsDom.formatTimeShort(c.created_at);
      li.querySelector(".comment-body").textContent = c.body;
      listEl.appendChild(li);
    }
  }

  function bindCard(card, song, engagement, visitorId) {
    card.dataset.songId = song.id;

    var title = RuinsDom.qs(".song-title", card);
    var artist = RuinsDom.qs(".song-artist", card);
    var note = RuinsDom.qs(".song-note", card);
    var likeBtn = RuinsDom.qs(".btn-like", card);
    var likeCount = RuinsDom.qs(".like-count", likeBtn);
    var toggleBtn = RuinsDom.qs(".btn-toggle-comments", card);
    var panel = RuinsDom.qs(".comments-panel", card);
    var listEl = RuinsDom.qs(".comment-list", card);
    var form = RuinsDom.qs(".comment-form", card);
    var cmCount = RuinsDom.qs(".comment-count", toggleBtn);
    var formMsg = RuinsDom.qs(".form-msg", form);

    title.textContent = song.title;
    artist.textContent = song.artist;
    note.textContent = song.note || "";
    note.hidden = !song.note;

    var count = engagement.counts[song.id] || 0;
    var isLiked = Boolean(engagement.liked[song.id]);
    likeCount.textContent = String(count);
    likeBtn.setAttribute("aria-pressed", isLiked ? "true" : "false");
    likeBtn.classList.toggle("is-liked", isLiked);

    if (!engagement.commentsBySong[song.id]) engagement.commentsBySong[song.id] = [];
    var comments = engagement.commentsBySong[song.id];
    cmCount.textContent = String(comments.length);
    renderComments(listEl, comments);

    var songMain = RuinsDom.qs(".song-main", card);
    songMain.addEventListener("click", async function () {
      var now = Date.now();
      if (lastSongPickAt[song.id] && now - lastSongPickAt[song.id] < 4000) {
        flashPlaylistStatus("请勿在短时间内重复上报同一首歌。", 2400);
        return;
      }

      if (!useCloud) {
        flashPlaylistStatus("当前为本地演示，点歌不会送达管理员。请在 config.js 填写 Supabase。", 4200);
        return;
      }

      try {
        await sbInsert("song_pick_requests", {
          song_id: song.id,
          visitor_id: visitorId,
        });
        lastSongPickAt[song.id] = Date.now();
        notifyPickToAdminWebhook(song, visitorId);
        if (pickNotifyWebhookUrl()) {
          flashPlaylistStatus(
            "已上报《" +
              song.title +
              "》。已尝试通过 Webhook 通知管理员邮箱；亦可至后台「点歌上报」查看。",
            4800
          );
        } else {
          flashPlaylistStatus(
            "已上报《" + song.title + "》，管理员可在后台「点歌上报」中查看。",
            4000
          );
        }
      } catch (e) {
        var err = e.message || String(e);
        setStatus(
          "点歌上报失败；若数据库尚未更新，请在 Supabase 执行 supabase/song_pick_requests.sql。 " +
            err.slice(0, 160)
        );
      }
    });

    likeBtn.addEventListener("click", async function (ev) {
      ev.stopPropagation();
      likeBtn.disabled = true;
      try {
        if (useCloud) {
          var out = await sbRpc("toggle_like", {
            p_song_id: song.id,
            p_visitor_id: visitorId,
          });
          if (Array.isArray(out)) out = out[0];
          var liked = out && typeof out.liked === "boolean" ? out.liked : !isLiked;
          var delta = liked ? 1 : -1;
          var next = Math.max(0, count + delta);
          count = next;
          isLiked = liked;
        } else {
          var r = toggleLikeLocal(song.id);
          count = r.count;
          isLiked = r.liked;
        }

        likeCount.textContent = String(count);
        likeBtn.setAttribute("aria-pressed", isLiked ? "true" : "false");
        likeBtn.classList.toggle("is-liked", isLiked);
      } catch (e) {
        formMsg.textContent = "点赞失败，请稍后再试。";
      } finally {
        likeBtn.disabled = false;
      }
    });

    toggleBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      var wasOpen = !panel.classList.contains("hidden");
      if (wasOpen) {
        panel.classList.add("hidden");
        toggleBtn.setAttribute("aria-expanded", "false");
      } else {
        closeAllPlaylistCommentPanels();
        panel.classList.remove("hidden");
        toggleBtn.setAttribute("aria-expanded", "true");
      }
    });

    form.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      formMsg.textContent = "";

      var fd = new FormData(form);
      var authorRaw = String(fd.get("author") || "").trim();
      var bodyRaw = String(fd.get("body") || "").trim();
      var author = authorRaw || "访客";

      if (!bodyRaw.length) {
        formMsg.textContent = "请输入评论内容。";
        return;
      }

      var submitBtn = RuinsDom.qs('button[type="submit"]', form);
      if (submitBtn) submitBtn.disabled = true;

      try {
        if (useCloud) {
          var inserted = await sbInsert("song_comments", {
            song_id: song.id,
            author: author,
            body: bodyRaw,
          });
          var row = Array.isArray(inserted) ? inserted[0] : inserted;
          comments.unshift({
            id: row.id,
            author: row.author,
            body: row.body,
            created_at: row.created_at,
          });
        } else {
          comments.unshift(addCommentLocal(song.id, author, bodyRaw));
        }

        cmCount.textContent = String(comments.length);
        renderComments(listEl, comments);
        form.reset();
        formMsg.textContent = "已发送";
      } catch (e) {
        formMsg.textContent = "发送失败，请稍后再试。";
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  async function init() {
    var visitorId = getVisitorId();
    var songs = [];
    var engagement;
    var statusLocked = false;

    if (useCloud) {
      try {
        songs = await loadSongsCloud();
        if (!songs.length) {
          setStatus(
            "云端歌单暂无曲目，已显示站内演示歌单（点赞与评论暂为本机）。请在管理后台新增歌曲并看到「已新增」提示后再刷新；若保存失败，页面会显示拒绝访问等红字。"
          );
          statusLocked = true;
          useCloud = false;
        } else {
          setStatus(playlistStatusHint());
          engagement = await loadEngagementCloud(
            songs.map(function (s) {
              return s.id;
            }),
            visitorId
          );
        }
      } catch (e) {
        setStatus("云端加载失败，已切换为本地演示模式（数据仅存本机）。");
        statusLocked = true;
        useCloud = false;
      }
    }

    if (!useCloud) {
      if (!statusLocked) setStatus(playlistStatusHint());
      songs = SAMPLE_SONGS.slice().sort(function (a, b) {
        return a.sort_order - b.sort_order;
      });
      engagement = loadEngagementLocal(
        songs.map(function (s) {
          return s.id;
        })
      );
    }

    var list = RuinsDom.qs("#song-list");
    var empty = RuinsDom.qs("#playlist-empty");
    var tpl = RuinsDom.qs("#song-card-template");

    if (!songs.length) {
      empty.hidden = false;
      empty.classList.remove("hidden");
      return;
    }

    empty.hidden = true;
    empty.classList.add("hidden");

    for (var i = 0; i < songs.length; i++) {
      var node = tpl.content.firstElementChild.cloneNode(true);
      bindCard(node, songs[i], engagement, visitorId);
      list.appendChild(node);
    }

    if (!window.__ruinsPlaylistCommentOutside) {
      window.__ruinsPlaylistCommentOutside = true;
      document.addEventListener("click", function (ev) {
        if (ev.target.closest(".song-comments")) return;
        closeAllPlaylistCommentPanels();
      });
    }
  }

  init();
})();
