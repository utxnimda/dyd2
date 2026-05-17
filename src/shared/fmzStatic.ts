/**
 * FMZ 全仓静态配置：与仓库根目录下 `shared/fmz-static.json` 同源。
 * 服务端请使用 `server/fmz-static.mjs` 中的 `loadFmzStatic()` 读取同一文件。
 */
import fmzStaticRaw from "../../shared/fmz-static.json";

export type FmzStaticConfig = typeof fmzStaticRaw;

/** 打包进前端的快照；更新 JSON 后需重新执行 `vite build` / `npm run dev` 编译。 */
export function getFmzStatic(): FmzStaticConfig {
  return fmzStaticRaw;
}

export default fmzStaticRaw;
