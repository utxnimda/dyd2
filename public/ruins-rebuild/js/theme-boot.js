/** 首屏前同步主题，避免闪屏（需在 <head> 内尽早加载） */
try {
  document.documentElement.setAttribute(
    "data-theme",
    localStorage.getItem("ruins_theme_v1") || "nocturne",
  );
} catch (e) {
  document.documentElement.setAttribute("data-theme", "nocturne");
}
