/**
 * Supabase 匿名（anon）REST 与存储 URL 拼装。
 * 各页在加载 config.js（window.JUKEBOX_CONFIG）后调用 RuinsAnonRest.wrap(cfg)。
 */
(function (global) {
  function wrap(cfg) {
    var base = String((cfg && cfg.supabaseUrl) || "").replace(/\/$/, "");
    var key = (cfg && cfg.supabaseAnonKey) || "";

    function jsonHeaders(extra) {
      var h = {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      };
      return Object.assign(h, extra || {});
    }

    return {
      base: base,
      anonKey: key,
      isReady: function () {
        return Boolean(base && key);
      },

      /** GET/POST /rest/v1/ 下的 path（含 query），如 songs?select=* */
      fetchRest: function (pathWithQuery, init) {
        init = init || {};
        var headers = jsonHeaders(init.headers || {});
        return fetch(base + "/rest/v1/" + pathWithQuery, Object.assign({}, init, { headers: headers }));
      },

      storagePublicObjectUrl: function (bucket, path) {
        var seg = encodeURIComponent(String(path || "")).replace(/%2F/g, "/");
        return base + "/storage/v1/object/public/" + bucket + "/" + seg;
      },

      storageUploadObjectUrl: function (bucket, filename) {
        return base + "/storage/v1/object/" + bucket + "/" + encodeURIComponent(filename);
      },
    };
  }

  global.RuinsAnonRest = { wrap: wrap };
})(typeof window !== "undefined" ? window : this);
