import type { RuinsPanelTab } from "../../shared/appRoute";

/** 与 public/ruins-rebuild/ 根目录下各页 HTML 文件名一致（供 iframe 与文档对照） */
export const RUINS_PANEL_HTML: Record<RuinsPanelTab, string> = {
  hub: "index.html",
  playlist: "playlist.html",
  treasures: "treasures.html",
  awards: "awards.html",
  admin: "admin.html",
};
