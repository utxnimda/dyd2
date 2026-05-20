/// <reference types="vite/client" />

declare const __FMZ_RELEASE_LABEL__: string;
declare const __FMZ_APP_VERSION__: string;

/** Feature flags — injected at build time from package.json fmzFeatures */
declare const __FEATURE_SANGUO__: boolean;
/** 夜观星象 Tab/面板；可为 false 而后台 sanguo 仍为 true（采集服务照常） */
declare const __FEATURE_SANGUO_UI__: boolean;
declare const __FEATURE_BAOBAO__: boolean;
declare const __FEATURE_AUDIO__: boolean;
/** 仅本地：浮窗「音频提取」插件；`fmzFeatures.audioPlugin: "local"` 时发布构建不含 */
declare const __FEATURE_AUDIO_PLUGIN__: boolean;
declare const __FEATURE_BATTLE__: boolean;
declare const __FEATURE_TREASURY__: boolean;
declare const __FEATURE_PRELIMINARY__: boolean;
declare const __FEATURE_USERS__: boolean;
declare const __FEATURE_QUOTA__: boolean;
declare const __FEATURE_CRIMES__: boolean;
declare const __FEATURE_DOUYU_DANMAKU__: boolean;
/** AI Agent plugin — floating panel for AI-powered danmaku analysis */
declare const __FEATURE_AI_AGENT__: boolean;
declare const __FEATURE_RUINS_REBUILD__: boolean;
/** Voice Clone — voice model training, TTS, and voice conversion */
declare const __FEATURE_VOICE_CLONE__: boolean;

declare module "*.jfif" {
  const src: string;
  export default src;
}

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
  /**
   * 生产环境 doseeing 头像基址；开发态默认走 Vite 代理 `/doseeing`。
   * 见 `src/features/battle/doseeingAvatar.ts`
   */
  readonly VITE_DOSEEING_BASE?: string;
  /** 设为 `0` 可关闭头像请求（如 E2E），默认开启 */
  readonly VITE_DOSEEING_AVATAR?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
