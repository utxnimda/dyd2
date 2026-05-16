(function () {
  var KEY = "ruins_theme_v1";
  var THEMES = ["nocturne", "ember", "aurora"];

  function apply(name) {
    if (THEMES.indexOf(name) < 0) name = "nocturne";
    document.documentElement.setAttribute("data-theme", name);
    try {
      localStorage.setItem(KEY, name);
    } catch (e) {}

    document.querySelectorAll("[data-set-theme]").forEach(function (btn) {
      var on = btn.getAttribute("data-set-theme") === name;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.classList.toggle("is-active", on);
    });
  }

  function init() {
    try {
      apply(localStorage.getItem(KEY) || "nocturne");
    } catch (e) {
      apply("nocturne");
    }

    document.querySelectorAll("[data-set-theme]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        apply(btn.getAttribute("data-set-theme"));
      });
    });

    var y = document.getElementById("year");
    if (y) y.textContent = String(new Date().getFullYear());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
