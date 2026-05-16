/** 废墟重建静态站公用 DOM 小工具（无构建步骤的 IIFE 模块） */
(function (global) {
  global.RuinsDom = {
    qs: function (sel, root) {
      return (root || document).querySelector(sel);
    },

    /** 与歌单评论时间格式一致 */
    formatTimeShort: function (iso) {
      if (!iso) return "";
      try {
        var d = new Date(iso);
        return d.toLocaleString("zh-CN", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
      } catch (e) {
        return "";
      }
    },

    /** 与旧版 admin show(el, on) 行为一致 */
    setVisible: function (el, on) {
      if (!el) return;
      el.hidden = !on;
      el.classList.toggle("hidden", !on);
    },
  };
})(typeof window !== "undefined" ? window : this);
