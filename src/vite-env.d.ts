/// <reference types="vite/client" />

declare const __FMZ_RELEASE_LABEL__: string;
declare const __FMZ_APP_VERSION__: string;

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  /** 与官网 fmz_config.js 的 LIVE_ROOM、P6E_PROJECT 一致 */
  readonly VITE_LIVE_ROOM?: string;
  readonly VITE_X_PROJECT?: string;
  readonly VITE_CURRENCY_PROPORTION?: string;
  /** 预赛金库列表条数，官网 PreliminaryData 为 100 */
  readonly VITE_PRELIMINARY_MONEY_PAGE_SIZE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
