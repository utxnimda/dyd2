(function () {
  var CFG = window.JUKEBOX_CONFIG || {};
  var api = window.RuinsAnonRest.wrap(CFG);
  var FEED = (CFG.awardsFeedUrl || "").trim();
  var useCloud = api.isReady();
  var LOCAL_KEY = "jukebox_awards_demo_v1";

  var SAMPLE = [
    {
      title: "示例 · 本地演示",
      detail: "接入数据库或外链后将显示真实记录。",
      source_url: "",
      awarded_at: new Date().toISOString().slice(0, 10),
      _src: "demo",
    },
  ];

  /** 演示用沙场积分榜；接入外站后将改为 fetch 结果并按 score 排序 */
  var MOCK_WAR_LEADERBOARD = [
    { name: "辕门吕奉先", score: 4521 },
    { name: "美髯关云长", score: 3890 },
    { name: "燕人张翼德", score: 3120 },
    { name: "常山赵子龙", score: 2640 },
    { name: "西凉马孟起", score: 2010 },
    { name: "长沙黄汉升", score: 1580 },
    { name: "天水姜伯约", score: 920 },
    { name: "南中孟获", score: 441 },
    { name: "参军马幼常", score: 220 },
    { name: "安乐刘公嗣", score: 45 },
  ];

  var els = {
    status: document.getElementById("awards-status"),
    list: document.getElementById("awards-list"),
    empty: document.getElementById("awards-empty"),
    year: document.getElementById("year"),
    leaderboard: document.getElementById("war-leaderboard-mount"),
  };

  function setStatus(text) {
    if (els.status) els.status.textContent = text || "";
  }

  function normalize(row, src) {
    return {
      title: row.title || row.name || "（无标题）",
      detail: row.detail || row.description || row.desc || "",
      source_url: row.source_url || row.url || row.link || "",
      awarded_at: row.awarded_at || row.date || row.award_date || "",
      _src: src || "db",
    };
  }

  async function fetchDb() {
    var res = await api.fetchRest("award_records?select=*&order=sort_order.asc,awarded_at.desc");
    if (!res.ok) throw new Error(await res.text());
    var rows = await res.json();
    return rows.map(function (r) {
      return normalize(r, "db");
    });
  }

  async function fetchRemoteFeed() {
    if (!FEED) return [];
    try {
      var res = await fetch(FEED, { mode: "cors" });
      if (!res.ok) throw new Error(String(res.status));
      var data = await res.json();
      var arr = Array.isArray(data) ? data : data.records || data.items || [];
      return arr.map(function (r) {
        var n = normalize(r, "remote");
        n._src = "remote";
        return n;
      });
    } catch (e) {
      setStatus(
        (els.status && els.status.textContent ? els.status.textContent + " " : "") +
          "外链数据未能加载（需对方站点允许 CORS）。",
      );
      return [];
    }
  }

  function readLocalDemo() {
    try {
      var raw = localStorage.getItem(LOCAL_KEY);
      if (!raw) return SAMPLE.slice();
      var arr = JSON.parse(raw);
      return Array.isArray(arr) && arr.length
        ? arr.map(function (r) {
            return normalize(r, "local");
          })
        : SAMPLE.slice();
    } catch (e) {
      return SAMPLE.slice();
    }
  }

  function mergeSort(dbRows, remoteRows, localRows) {
    var seen = {};
    var out = [];

    function key(r) {
      return (r.title || "") + "|" + (r.awarded_at || "");
    }

    function pushUnique(r) {
      var k = key(r);
      if (seen[k]) return;
      seen[k] = true;
      out.push(r);
    }

    var i;
    for (i = 0; i < remoteRows.length; i++) pushUnique(remoteRows[i]);
    for (i = 0; i < dbRows.length; i++) pushUnique(dbRows[i]);
    for (i = 0; i < localRows.length; i++) pushUnique(localRows[i]);

    out.sort(function (a, b) {
      var da = String(a.awarded_at || "");
      var db = String(b.awarded_at || "");
      return db.localeCompare(da);
    });

    return out;
  }

  function renderLeaderboard(rows) {
    var mount = els.leaderboard;
    if (!mount) return;

    var sorted = rows
      .slice()
      .sort(function (a, b) {
        return (b.score || 0) - (a.score || 0);
      })
      .slice(0, 10);

    var html =
      '<table class="war-leaderboard-table">' +
      "<thead><tr>" +
      '<th scope="col">名次</th>' +
      '<th scope="col">旗号</th>' +
      '<th scope="col">战功</th>' +
      "</tr></thead><tbody>";

    for (var i = 0; i < sorted.length; i++) {
      var rank = i + 1;
      var row = sorted[i];
      var topClass = rank <= 3 ? " war-rank--top war-rank--" + rank : "";

      html +=
        '<tr class="' + topClass.trim() + '">' +
        '<td class="war-rank-cell"><span class="war-rank-num">' +
        rank +
        "</span></td>" +
        '<td class="war-name-cell">' +
        escapeHtml(row.name) +
        "</td>" +
        '<td class="war-score-cell">' +
        String(row.score != null ? row.score : 0) +
        "</td>" +
        "</tr>";
    }

    html += "</tbody></table>";
    mount.innerHTML = html;
  }

  function renderList(rows) {
    els.list.innerHTML = "";
    if (!rows.length) {
      els.empty.hidden = false;
      els.empty.classList.remove("hidden");
      return;
    }
    els.empty.hidden = true;
    els.empty.classList.add("hidden");

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var li = document.createElement("li");
      li.className = "awards-item";

      var badge = "";
      if (r._src === "remote") badge = '<span class="awards-badge">外链</span>';
      else if (r._src === "demo" || r._src === "local")
        badge = '<span class="awards-badge awards-badge-muted">演示</span>';

      var linkPart = "";
      if (r.source_url && /^https?:\/\//i.test(r.source_url)) {
        linkPart =
          '<a class="awards-link" href="' +
          r.source_url.replace(/"/g, "&quot;") +
          '" target="_blank" rel="noopener noreferrer">来源</a>';
      }

      li.innerHTML =
        '<div class="awards-head">' +
        badge +
        '<span class="awards-date">' +
        (r.awarded_at || "") +
        "</span></div>" +
        '<h2 class="awards-title">' +
        escapeHtml(r.title) +
        "</h2>" +
        '<p class="awards-detail">' +
        escapeHtml(r.detail) +
        "</p>" +
        '<div class="awards-meta">' +
        linkPart +
        "</div>";

      els.list.appendChild(li);
    }
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function init() {
    renderLeaderboard(MOCK_WAR_LEADERBOARD);

    var dbRows = [];
    var remoteRows = [];
    var localRows = readLocalDemo();

    if (useCloud) {
      setStatus(FEED ? "已连接数据库；并尝试加载 awardsFeedUrl 外链。" : "已连接数据库。");
      try {
        dbRows = await fetchDb();
      } catch (e) {
        setStatus("数据库不可用，使用演示数据。");
        useCloud = false;
      }
    }

    if (useCloud && FEED) {
      remoteRows = await fetchRemoteFeed();
    }

    if (!useCloud) {
      setStatus("本地演示模式。填写 config.js 中 Supabase 与可选 awardsFeedUrl 后可同步数据。");
      dbRows = [];
      remoteRows = FEED ? await fetchRemoteFeed() : [];
    }

    var merged = mergeSort(dbRows, remoteRows, useCloud ? [] : localRows);
    renderList(merged);
  }

  init();
})();
