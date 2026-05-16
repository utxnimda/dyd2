(function () {
  var CFG = window.JUKEBOX_CONFIG || {};
  var api = window.RuinsAnonRest.wrap(CFG);
  var BUCKET = "gallery";
  var useCloud = api.isReady();
  var STORAGE_KEY = "jukebox_gallery_local_v1";

  var els = {
    status: document.getElementById("treasures-status"),
    form: document.getElementById("form-upload"),
    file: document.getElementById("file-input"),
    caption: document.getElementById("caption-input"),
    uploadMsg: document.getElementById("upload-msg"),
    grid: document.getElementById("gallery-grid"),
    empty: document.getElementById("gallery-empty"),
    year: document.getElementById("year"),
  };

  function setStatus(text) {
    if (els.status) els.status.textContent = text || "";
  }

  function setUploadMsg(text, bad) {
    if (!els.uploadMsg) return;
    els.uploadMsg.textContent = text || "";
    els.uploadMsg.style.color = bad ? "var(--danger, #fb7185)" : "var(--muted)";
  }

  function safeName(name) {
    return String(name || "image")
      .replace(/[^\w.\u4e00-\u9fff-]/g, "_")
      .slice(0, 80);
  }

  function readLocal() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function writeLocal(items) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch (e) {
      setUploadMsg("本地存储已满或不可用，请改用云端。", true);
    }
  }

  async function fetchGalleryCloud() {
    var res = await api.fetchRest("gallery_items?select=*&approval_status=eq.approved&order=created_at.desc");
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async function uploadCloud(file, caption) {
    var filename = Date.now() + "_" + crypto.randomUUID().slice(0, 8) + "_" + safeName(file.name);
    var uploadUrl = api.storageUploadObjectUrl(BUCKET, filename);

    var up = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        apikey: api.anonKey,
        Authorization: "Bearer " + api.anonKey,
        "Content-Type": file.type || "application/octet-stream",
      },
      body: file,
    });

    if (!up.ok) throw new Error((await up.text()) || "上传失败");

    var row = {
      path: filename,
      caption: caption || "",
      approval_status: "pending",
    };

    var ins = await api.fetchRest("gallery_items", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(row),
    });

    if (!ins.ok) throw new Error((await ins.text()) || "写入记录失败");
    return ins.json();
  }

  function uploadLocal(file, caption, cb) {
    if (file.size > 600 * 1024) {
      setUploadMsg("本地演示单张请勿超过约 600KB。", true);
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var items = readLocal();
      items.unshift({
        id: crypto.randomUUID(),
        dataUrl: reader.result,
        caption: caption || "",
        created_at: new Date().toISOString(),
      });
      writeLocal(items);
      cb();
    };
    reader.readAsDataURL(file);
  }

  function renderItem(url, caption, alt) {
    var fig = document.createElement("figure");
    fig.className = "gallery-item";
    var img = document.createElement("img");
    img.src = url;
    img.alt = alt || "";
    img.loading = "lazy";
    var fc = document.createElement("figcaption");
    fc.textContent = caption || "";
    fig.appendChild(img);
    fig.appendChild(fc);
    return fig;
  }

  async function render() {
    els.grid.innerHTML = "";

    if (useCloud) {
      try {
        var rows = await fetchGalleryCloud();
        setStatus("已连接云端相册。");
        if (!rows.length) {
          els.empty.hidden = false;
          els.empty.classList.remove("hidden");
          return;
        }
        els.empty.hidden = true;
        els.empty.classList.add("hidden");
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          els.grid.appendChild(renderItem(api.storagePublicObjectUrl(BUCKET, r.path), r.caption, r.caption));
        }
      } catch (e) {
        setStatus("云端相册不可用，已切换本地演示（仅本机可见）。");
        useCloud = false;
        renderLocalFallback();
      }
      return;
    }

    renderLocalFallback();
  }

  function renderLocalFallback() {
    setStatus("本地演示：照片仅存于当前浏览器。配置 Supabase 并创建存储桶后可云端同步。");
    var items = readLocal();
    if (!items.length) {
      els.empty.hidden = false;
      els.empty.classList.remove("hidden");
      return;
    }
    els.empty.hidden = true;
    els.empty.classList.add("hidden");
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      els.grid.appendChild(renderItem(it.dataUrl, it.caption, it.caption));
    }
  }

  els.form.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    setUploadMsg("");

    var file = els.file.files && els.file.files[0];
    if (!file) {
      setUploadMsg("请先选择一张图片。", true);
      return;
    }

    var cap = (els.caption.value || "").trim();

    try {
      if (useCloud) {
        await uploadCloud(file, cap);
        setUploadMsg("已提交审核，管理员通过后将展示在相册墙。");
        els.form.reset();
        await render();
      } else {
        uploadLocal(file, cap, function () {
          setUploadMsg("已保存到本地演示相册");
          els.form.reset();
          renderLocalFallback();
        });
      }
    } catch (e) {
      setUploadMsg(e.message || String(e), true);
    }
  });

  render();
})();
