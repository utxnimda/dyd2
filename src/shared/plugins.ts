import { defineAsyncComponent, type Component } from "vue";

/** Descriptor for a floating-panel plugin (Chrome-extension style). */
export interface PluginDescriptor {
  /** Unique plugin id */
  id: string;
  /** Display name shown in the plugin menu */
  label: string;
  /** Emoji or icon character */
  icon: string;
  /** Short description */
  description: string;
  /** The Vue component to render inside the floating panel */
  component: Component | null;
  /** Build-time feature flag — when false the plugin is completely excluded */
  enabled: boolean;
}

/**
 * All registered plugins.
 * Components are lazy-loaded via defineAsyncComponent so they are
 * tree-shaken when the corresponding feature flag is false.
 */
export const ALL_PLUGINS: PluginDescriptor[] = [
  {
    id: "audio",
    label: "音频提取",
    icon: "🎵",
    description: "从视频中提取唱歌音频，自动识别并分割歌曲",
    component: __FEATURE_AUDIO__
      ? defineAsyncComponent(
          () => import("../features/audio/AudioExtractorPanel.vue"),
        )
      : null,
    enabled: __FEATURE_AUDIO__,
  },
];

/** Only plugins whose feature flag is on */
export function getEnabledPlugins(): PluginDescriptor[] {
  return ALL_PLUGINS.filter((p) => p.enabled && p.component);
}
