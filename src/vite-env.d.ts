/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  /** package.json version，如 0.3.0 */
  readonly VITE_APP_VERSION?: string;
  /** 发布标签，如 v0.3（见 package.json 的 fmzReleaseLabel） */
  readonly VITE_APP_RELEASE_LABEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
