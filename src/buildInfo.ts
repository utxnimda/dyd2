/**
 * 构建时由 vite.config `define` 注入，与 package.json 的 version / fmzReleaseLabel 一致。
 * 不用 import.meta.env.VITE_*，避免个别环境下替换不生效导致界面一直显示旧版本号。
 */
export const FMZ_RELEASE_LABEL: string = __FMZ_RELEASE_LABEL__;
export const FMZ_APP_VERSION: string = __FMZ_APP_VERSION__;
