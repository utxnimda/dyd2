(function () {
  var CFG = window.JUKEBOX_CONFIG || {};
  var BASE = (CFG.supabaseUrl || "").replace(/\/$/, "");
  var ANON = CFG.supabaseAnonKey || "";
  var SESSION_KEY = "jukebox_admin_auth_v1";
  var GALLERY_BUCKET = "gallery";

  var els = {
    loginPanel: document.getElementById("panel-login"),
    dashPanel: document.getElementById("panel-dash"),
    configError: document.getElementById("config-error"),
    formLogin: document.getElementById("form-login"),
    loginError: document.getElementById("login-error"),
    btnLogout: document.getElementById("btn-logout"),
    dashMsg: document.getElementById("dash-msg"),
    formSong: document.getElementById("form-song"),
    fieldId: document.getElementById("field-id"),
    fieldTitle: document.getElementById("field-title"),
    fieldArtist: document.getElementById("field-artist"),
    fieldNote: document.getElementById("field-note"),
    fieldSort: document.getElementById("field-sort"),
    btnCancelEdit: document.getElementById("btn-cancel-edit"),
    formAddTitle: document.getElementById("form-add-title"),
    btnSave: document.getElementById("btn-save"),
    tableBody: document.getElementById("song-table-body"),
    tableEmpty: document.getElementById("table-empty"),
    pickTableBody: document.getElementById("pick-table-body"),
    pickTableEmpty: document.getElementById("pick-table-empty"),
    formAward: document.getElementById("form-award"),
    awardFieldId: document.getElementById("award-field-id"),
    awardFieldTitle: document.getElementById("award-field-title"),
    awardFieldDetail: document.getElementById("award-field-detail"),
    awardFieldSource: document.getElementById("award-field-source"),
    awardFieldDate: document.getElementById("award-field-date"),
    awardFieldSort: document.getElementById("award-field-sort"),
    awardFormTitle: document.getElementById("award-form-title"),
    btnAwardSave: document.getElementById("btn-award-save"),
    btnAwardCancel: document.getElementById("btn-award-cancel"),
    awardTableBody: document.getElementById("award-table-body"),
    awardTableEmpty: document.getElementById("award-table-empty"),
    galleryPendingBody: document.getElementById("gallery-pending-body"),
    galleryPendingEmpty: document.getElementById("gallery-pending-empty"),
  };

  function setDashMsg(text, isError) {
    if (!els.dashMsg) return;
    els.dashMsg.textContent = text || "";
    els.dashMsg.style.color = isError ? "var(--danger, #fb7185)" : "var(--muted)";
  }

  function readSession() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function writeSession(data) {
    if (!data) {
      sessionStorage.removeItem(SESSION_KEY);
      return;
    }
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(data));
  }

  async function login(email, password) {
    var res = await fetch(BASE + "/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: {
        apikey: ANON,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: email, password: password }),
    });
    var text = await res.text();
    if (!res.ok) {
      var err = text;
      try {
        err = JSON.parse(text).error_description || JSON.parse(text).msg || text;
      } catch (e) {}
      throw new Error(err || "登录失败");
    }
    return JSON.parse(text);
  }

  async function refreshTokens(refreshToken) {
    var res = await fetch(BASE + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: {
        apikey: ANON,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    var text = await res.text();
    if (!res.ok) throw new Error("会话已过期，请重新登录");
    return JSON.parse(text);
  }

  async function getAccessToken() {
    var s = readSession();
    if (!s || !s.access_token) return null;

    var expMs = s.expires_at || 0;
    if (Date.now() < expMs - 15000) return s.access_token;

    if (s.refresh_token) {
      try {
        var next = await refreshTokens(s.refresh_token);
        var payload = {
          access_token: next.access_token,
          refresh_token: next.refresh_token || s.refresh_token,
          expires_at: Date.now() + (next.expires_in || 3600) * 1000,
        };
        writeSession(payload);
        return payload.access_token;
      } catch (e) {
        writeSession(null);
        return null;
      }
    }

    writeSession(null);
    return null;
  }

  async function api(method, path, body, query) {
    var token = await getAccessToken();
    if (!token) throw new Error("未登录");

    var url = BASE + "/rest/v1/" + path + (query ? "?" + query : "");
    var headers = {
      apikey: ANON,
      Authorization: "Bearer " + token,
    };
    if (body !== undefined && method !== "GET" && method !== "HEAD") {
      headers["Content-Type"] = "application/json";
      headers["Prefer"] = "return=representation";
    }

    var res = await fetch(url, {
      method: method,
      headers: headers,
      body:
        body !== undefined && method !== "GET" && method !== "HEAD"
          ? JSON.stringify(body)
          : undefined,
    });

    var txt = await res.text();
    if (res.status === 401) {
      writeSession(null);
      throw new Error("登录已失效，请重新登录");
    }
    if (!res.ok) throw new Error(txt || "请求失败");

    if ((method === "DELETE" || method === "GET") && !txt) return method === "GET" ? [] : null;
    if (!txt) return null;
    try {
      return JSON.parse(txt);
    } catch (e) {
      return txt;
    }
  }

  function resetSongForm() {
    els.formSong.reset();
    els.fieldId.value = "";
    els.fieldSort.value = "0";
    els.formAddTitle.textContent = "新增歌曲";
    els.btnSave.textContent = "保存";
  }

  function enterEdit(row) {
    els.fieldId.value = row.id;
    els.fieldTitle.value = row.title || "";
    els.fieldArtist.value = row.artist || "";
    els.fieldNote.value = row.note || "";
    els.fieldSort.value = String(row.sort_order != null ? row.sort_order : 0);
    els.formAddTitle.textContent = "编辑歌曲";
    els.btnSave.textContent = "保存修改";
    els.fieldTitle.focus();
  }

  async function loadSongs() {
    var rows = await api("GET", "songs", undefined, "select=*&order=sort_order.asc");
    return Array.isArray(rows) ? rows : [];
  }

  function renderTable(rows) {
    els.tableBody.innerHTML = "";
    RuinsDom.setVisible(els.tableEmpty, rows.length === 0);

    for (var i = 0; i < rows.length; i++) {
      (function (r) {
        var tr = document.createElement("tr");
        tr.innerHTML =
          "<td></td><td></td><td></td><td></td><td class=\"admin-actions\"></td>";

        var cells = tr.querySelectorAll("td");
        cells[0].textContent = String(r.sort_order != null ? r.sort_order : "");
        cells[1].textContent = r.title || "";
        cells[2].textContent = r.artist || "";
        cells[3].textContent = r.note || "";
        cells[3].className = "admin-note";

        var btnEdit = document.createElement("button");
        btnEdit.type = "button";
        btnEdit.className = "btn btn-ghost btn-sm";
        btnEdit.textContent = "编辑";
        btnEdit.addEventListener("click", function () {
          enterEdit(r);
          window.scrollTo({ top: 0, behavior: "smooth" });
        });

        var btnDel = document.createElement("button");
        btnDel.type = "button";
        btnDel.className = "btn btn-ghost btn-sm";
        btnDel.textContent = "删除";
        btnDel.addEventListener("click", async function () {
          if (!confirm("确定删除《" + (r.title || "") + "》？")) return;
          try {
            await api(
              "DELETE",
              "songs",
              undefined,
              "id=eq." + encodeURIComponent(r.id)
            );
            setDashMsg("已删除");
            await refreshTable();
          } catch (e) {
            setDashMsg(e.message || String(e), true);
          }
        });

        cells[4].appendChild(btnEdit);
        cells[4].appendChild(btnDel);
        els.tableBody.appendChild(tr);
      })(rows[i]);
    }
  }

  function formatPickTime(iso) {
    if (!iso) return "";
    try {
      var d = new Date(iso);
      return d.toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch (e) {
      return "";
    }
  }

  function shortVisitorId(s) {
    if (!s || s.length < 8) return s || "—";
    return s.slice(0, 8) + "…";
  }

  async function loadPickRequests() {
    var rows = await api(
      "GET",
      "song_pick_requests",
      undefined,
      "select=id,created_at,visitor_id,songs(title,artist)&order=created_at.desc"
    );
    return Array.isArray(rows) ? rows : [];
  }

  function renderPickTable(rows) {
    if (!els.pickTableBody || !els.pickTableEmpty) return;
    els.pickTableBody.innerHTML = "";
    RuinsDom.setVisible(els.pickTableEmpty, rows.length === 0);

    for (var i = 0; i < rows.length; i++) {
      (function (r) {
        var tr = document.createElement("tr");
        tr.innerHTML =
          "<td></td><td></td><td></td><td></td><td class=\"admin-actions\"></td>";

        var cells = tr.querySelectorAll("td");
        cells[0].textContent = formatPickTime(r.created_at);

        var sg = r.songs;
        cells[1].textContent = sg && sg.title ? sg.title : "（未知或已删曲）";
        cells[2].textContent = sg && sg.artist ? sg.artist : "—";

        cells[3].textContent = shortVisitorId(r.visitor_id);
        cells[3].title = r.visitor_id || "";

        var btnDel = document.createElement("button");
        btnDel.type = "button";
        btnDel.className = "btn btn-ghost btn-sm";
        btnDel.textContent = "删除";
        btnDel.addEventListener("click", async function () {
          if (!confirm("确定删除这条点歌记录？")) return;
          try {
            await api(
              "DELETE",
              "song_pick_requests",
              undefined,
              "id=eq." + encodeURIComponent(r.id)
            );
            setDashMsg("已删除点歌记录");
            await refreshPickTable();
          } catch (e) {
            setDashMsg(e.message || String(e), true);
          }
        });

        cells[4].appendChild(btnDel);
        els.pickTableBody.appendChild(tr);
      })(rows[i]);
    }
  }

  function galleryPublicUrl(path) {
    var seg = encodeURIComponent(String(path || "")).replace(/%2F/g, "/");
    return BASE + "/storage/v1/object/public/" + GALLERY_BUCKET + "/" + seg;
  }

  async function deleteGalleryStorage(path) {
    var token = await getAccessToken();
    if (!token) throw new Error("未登录");
    var clean = String(path || "").replace(/^\/+/, "");
    var url =
      BASE + "/storage/v1/object/" + GALLERY_BUCKET + "/" + encodeURIComponent(clean);
    var res = await fetch(url, {
      method: "DELETE",
      headers: {
        apikey: ANON,
        Authorization: "Bearer " + token,
      },
    });
    if (!res.ok && res.status !== 404) {
      var txt = await res.text();
      throw new Error(txt || "删除存储文件失败");
    }
  }

  async function loadGalleryPending() {
    var rows = await api(
      "GET",
      "gallery_items",
      undefined,
      "select=*&approval_status=eq.pending&order=created_at.desc"
    );
    return Array.isArray(rows) ? rows : [];
  }

  function renderGalleryPending(rows) {
    if (!els.galleryPendingBody || !els.galleryPendingEmpty) return;
    els.galleryPendingBody.innerHTML = "";
    RuinsDom.setVisible(els.galleryPendingEmpty, rows.length === 0);

    for (var i = 0; i < rows.length; i++) {
      (function (r) {
        var tr = document.createElement("tr");
        tr.innerHTML =
          "<td class=\"admin-gallery-thumb\"></td><td></td><td></td><td class=\"admin-actions\"></td>";

        var cells = tr.querySelectorAll("td");
        var thumbCell = cells[0];
        var img = document.createElement("img");
        img.alt = "";
        img.className = "admin-gallery-thumb-img";
        img.loading = "lazy";
        img.src = galleryPublicUrl(r.path);
        thumbCell.appendChild(img);

        cells[1].textContent = (r.caption || "").trim() || "—";
        cells[2].textContent = formatPickTime(r.created_at);

        var btnOk = document.createElement("button");
        btnOk.type = "button";
        btnOk.className = "btn btn-primary btn-sm";
        btnOk.textContent = "通过";
        btnOk.addEventListener("click", async function () {
          if (!confirm("通过审核后，该照片将对所有访客可见。确定？")) return;
          try {
            await api(
              "PATCH",
              "gallery_items",
              { approval_status: "approved" },
              "id=eq." + encodeURIComponent(r.id)
            );
            setDashMsg("已通过审核");
            await refreshGalleryPending();
          } catch (e) {
            setDashMsg(e.message || String(e), true);
          }
        });

        var btnNo = document.createElement("button");
        btnNo.type = "button";
        btnNo.className = "btn btn-ghost btn-sm";
        btnNo.textContent = "拒绝";
        btnNo.addEventListener("click", async function () {
          if (!confirm("拒绝后将删除该条记录与存储中的图片，确定？")) return;
          try {
            await deleteGalleryStorage(r.path);
            await api(
              "DELETE",
              "gallery_items",
              undefined,
              "id=eq." + encodeURIComponent(r.id)
            );
            setDashMsg("已拒绝并删除");
            await refreshGalleryPending();
          } catch (e) {
            setDashMsg(e.message || String(e), true);
          }
        });

        cells[3].appendChild(btnOk);
        cells[3].appendChild(btnNo);
        els.galleryPendingBody.appendChild(tr);
      })(rows[i]);
    }
  }

  async function refreshGalleryPending() {
    if (!els.galleryPendingBody) return;
    try {
      var rows = await loadGalleryPending();
      renderGalleryPending(rows);
    } catch (e) {
      renderGalleryPending([]);
      var msg = e.message || String(e);
      if (/approval_status|42703|column.*does not exist/i.test(msg)) {
        setDashMsg(
          "相册审核字段未就绪：打开 Supabase 控制台 → 左侧 SQL → New query，将项目里 supabase/gallery_approval_migration.sql 的**全文**粘贴进去 → 点 Run 执行 → 回到本页刷新。",
          true
        );
      } else if (/permission denied|42501|violates row-level/i.test(msg)) {
        setDashMsg("无法读取待审核相册：确认已登录管理员账号且在 admin_users 中。", true);
      } else {
        setDashMsg("相册审核加载失败：" + msg.slice(0, 200), true);
      }
    }
  }

  async function refreshPickTable() {
    try {
      var rows = await loadPickRequests();
      renderPickTable(rows);
    } catch (e) {
      renderPickTable([]);
      var msg = e.message || String(e);
      if (/could not find the table|relation.*does not exist|404/i.test(msg)) {
        setDashMsg(
          "点歌表未创建：请在 Supabase SQL Editor 执行 supabase/song_pick_requests.sql（或重新运行 schema.sql）。",
          true
        );
      } else if (/permission denied|42501|violates row-level/i.test(msg)) {
        setDashMsg("无法读取点歌上报：确认已登录管理员账号且在 admin_users 中。", true);
      } else {
        setDashMsg("点歌上报加载失败：" + msg.slice(0, 200), true);
      }
    }
  }

  async function refreshTable() {
    try {
      var rows = await loadSongs();
      renderTable(rows);
    } catch (e) {
      var msg = e.message || String(e);
      if (/permission denied|42501|violates row-level/i.test(msg)) {
        setDashMsg(
          "没有管理权限：请在数据库执行 insert into admin_users (user_id) values ('你的用户uuid')。",
          true
        );
      } else {
        setDashMsg(msg, true);
      }
    }
  }

  async function refreshAwardTable() {
    try {
      var rows = await loadAwards();
      renderAwardTable(rows);
    } catch (e) {
      renderAwardTable([]);
      setDashMsg(
        "获奖记录表未就绪或无权访问：请在数据库执行 supabase/gallery_awards.sql。（" +
          (e.message || String(e)) +
          "）",
        true
      );
    }
  }

  async function loadAwards() {
    var rows = await api("GET", "award_records", undefined, "select=*&order=sort_order.asc,awarded_at.desc");
    return Array.isArray(rows) ? rows : [];
  }

  function resetAwardForm() {
    els.formAward.reset();
    els.awardFieldId.value = "";
    els.awardFieldSort.value = "0";
    els.awardFormTitle.textContent = "新增获奖记录（中军帐下）";
    els.btnAwardSave.textContent = "保存记录";
  }

  function enterAwardEdit(row) {
    els.awardFieldId.value = row.id;
    els.awardFieldTitle.value = row.title || "";
    els.awardFieldDetail.value = row.detail || "";
    els.awardFieldSource.value = row.source_url || "";
    els.awardFieldDate.value = row.awarded_at ? String(row.awarded_at).slice(0, 10) : "";
    els.awardFieldSort.value = String(row.sort_order != null ? row.sort_order : 0);
    els.awardFormTitle.textContent = "编辑获奖记录";
    els.btnAwardSave.textContent = "保存修改";
    els.awardFieldTitle.focus();
  }

  function renderAwardTable(rows) {
    els.awardTableBody.innerHTML = "";
    RuinsDom.setVisible(els.awardTableEmpty, rows.length === 0);

    for (var i = 0; i < rows.length; i++) {
      (function (r) {
        var tr = document.createElement("tr");
        tr.innerHTML =
          "<td></td><td></td><td></td><td></td><td class=\"admin-actions\"></td>";

        var cells = tr.querySelectorAll("td");
        cells[0].textContent = String(r.sort_order != null ? r.sort_order : "");
        cells[1].textContent = r.title || "";
        cells[2].textContent = r.awarded_at ? String(r.awarded_at).slice(0, 10) : "";
        cells[3].textContent = (r.detail || "").slice(0, 48) + ((r.detail || "").length > 48 ? "…" : "");
        cells[3].className = "admin-note";

        var btnEdit = document.createElement("button");
        btnEdit.type = "button";
        btnEdit.className = "btn btn-ghost btn-sm";
        btnEdit.textContent = "编辑";
        btnEdit.addEventListener("click", function () {
          enterAwardEdit(r);
          window.scrollTo({ top: 0, behavior: "smooth" });
        });

        var btnDel = document.createElement("button");
        btnDel.type = "button";
        btnDel.className = "btn btn-ghost btn-sm";
        btnDel.textContent = "删除";
        btnDel.addEventListener("click", async function () {
          if (!confirm("确定删除该条获奖记录？")) return;
          try {
            await api(
              "DELETE",
              "award_records",
              undefined,
              "id=eq." + encodeURIComponent(r.id)
            );
            setDashMsg("获奖记录已删除");
            await refreshAwardTable();
          } catch (e) {
            setDashMsg(e.message || String(e), true);
          }
        });

        cells[4].appendChild(btnEdit);
        cells[4].appendChild(btnDel);
        els.awardTableBody.appendChild(tr);
      })(rows[i]);
    }
  }

  async function showDashboard() {
    RuinsDom.setVisible(els.loginPanel, false);
    RuinsDom.setVisible(els.dashPanel, true);
    resetSongForm();
    resetAwardForm();
    setDashMsg("");
    await refreshTable();
    await refreshPickTable();
    await refreshGalleryPending();
    await refreshAwardTable();
  }

  function showLogin() {
    writeSession(null);
    RuinsDom.setVisible(els.loginPanel, true);
    RuinsDom.setVisible(els.dashPanel, false);
    if (els.loginError) els.loginError.textContent = "";
    RuinsDom.setVisible(els.configError, false);
    if (els.formLogin) {
      els.formLogin.hidden = false;
      els.formLogin.classList.remove("hidden");
    }
  }

  function boot() {
    if (!BASE || !ANON) {
      RuinsDom.setVisible(els.loginPanel, true);
      RuinsDom.setVisible(els.dashPanel, false);
      RuinsDom.setVisible(els.configError, true);
      els.configError.textContent =
        "当前看不到登录表单，是因为尚未配置 Supabase。请在项目里的 config.js 填写 supabaseUrl 与 supabaseAnonKey（在 Supabase：左侧 Project Settings（齿轮）→ API，复制 Project URL 与 anon public 密钥），保存后刷新本页即可出现邮箱与密码输入框。";
      if (els.formLogin) {
        els.formLogin.hidden = true;
        els.formLogin.classList.add("hidden");
      }
      return;
    }

    RuinsDom.setVisible(els.configError, false);
    if (els.formLogin) {
      els.formLogin.hidden = false;
      els.formLogin.classList.remove("hidden");
    }

    getAccessToken().then(function (tok) {
      if (tok) showDashboard();
      else showLogin();
    });
  }

  els.formLogin.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    els.loginError.textContent = "";
    var fd = new FormData(els.formLogin);
    var email = String(fd.get("email") || "").trim();
    var password = String(fd.get("password") || "");

    try {
      var session = await login(email, password);
      writeSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: Date.now() + (session.expires_in || 3600) * 1000,
      });
      await showDashboard();
    } catch (e) {
      els.loginError.textContent = e.message || String(e);
    }
  });

  els.btnLogout.addEventListener("click", function () {
    showLogin();
  });

  els.btnCancelEdit.addEventListener("click", function () {
    resetSongForm();
    setDashMsg("");
  });

  els.btnAwardCancel.addEventListener("click", function () {
    resetAwardForm();
    setDashMsg("");
  });

  els.formAward.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    setDashMsg("");

    var title = els.awardFieldTitle.value.trim();
    var detail = els.awardFieldDetail.value.trim();
    var sourceUrl = els.awardFieldSource.value.trim();
    var dateStr = els.awardFieldDate.value.trim();
    var sortOrder = parseInt(els.awardFieldSort.value, 10);
    if (isNaN(sortOrder)) sortOrder = 0;

    var aid = els.awardFieldId.value.trim();

    var payload = {
      title: title,
      detail: detail,
      source_url: sourceUrl,
      awarded_at: dateStr || null,
      sort_order: sortOrder,
    };

    try {
      if (aid) {
        await api("PATCH", "award_records", payload, "id=eq." + encodeURIComponent(aid));
        setDashMsg("获奖记录已更新");
      } else {
        await api("POST", "award_records", payload);
        setDashMsg("获奖记录已新增");
      }
      resetAwardForm();
      await refreshAwardTable();
    } catch (e) {
      var msg = e.message || String(e);
      if (/permission denied|42501|violates row-level/i.test(msg)) {
        setDashMsg(
          "拒绝访问：确认 admin_users 与 gallery_awards.sql 已执行。",
          true
        );
      } else {
        setDashMsg(msg, true);
      }
    }
  });

  els.formSong.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    setDashMsg("");

    var title = els.fieldTitle.value.trim();
    var artist = els.fieldArtist.value.trim();
    var note = els.fieldNote.value.trim();
    var sortOrder = parseInt(els.fieldSort.value, 10);
    if (isNaN(sortOrder)) sortOrder = 0;

    var id = els.fieldId.value.trim();

    var payload = {
      title: title,
      artist: artist,
      note: note,
      link_url: "",
      sort_order: sortOrder,
    };

    try {
      if (id) {
        await api("PATCH", "songs", payload, "id=eq." + encodeURIComponent(id));
        setDashMsg("已保存修改");
      } else {
        await api("POST", "songs", payload);
        setDashMsg("已新增歌曲");
      }
      resetSongForm();
      await refreshTable();
    } catch (e) {
      var msg = e.message || String(e);
      if (/permission denied|42501|violates row-level/i.test(msg)) {
        setDashMsg(
          "拒绝访问：当前账号不在 admin_users 中，或数据库策略未更新。请执行 supabase 目录下的 SQL。",
          true
        );
      } else {
        setDashMsg(msg, true);
      }
    }
  });

  boot();
})();
