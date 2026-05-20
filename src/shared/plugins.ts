import { defineAsyncComponent, ref, type Component } from "vue";
import aiBotIconUrl from "../../image/BOT.jpg?url";

/** Descriptor for a floating-panel plugin (Chrome-extension style). */
export interface PluginDescriptor {
  /** Unique plugin id */
  id: string;
  /** Display name shown in the plugin menu */
  label: string;
  /** Emoji or icon character */
  icon: string;
  /** When set, PluginHost shows this image instead of emoji in menu / pills / float header */
  iconUrl?: string;
  /** Short description */
  description: string;
  /** The Vue component to render inside the floating panel */
  component: Component | null;
  /** Build-time feature flag — when false the plugin is completely excluded */
  enabled: boolean;
  /**
   * Panel display mode:
   * - "float" (default): draggable floating window
   * - "side": right-side slide-out panel (full height, like ChatGPT)
   */
  panelMode?: "float" | "side";
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
    component:
      __FEATURE_AUDIO__ && __FEATURE_AUDIO_PLUGIN__
        ? defineAsyncComponent(
            () => import("../features/audio/AudioExtractorPanel.vue"),
          )
        : null,
    enabled: __FEATURE_AUDIO__ && __FEATURE_AUDIO_PLUGIN__,
  },
  {
    id: "ai-agent",
    label: "AI 分析",
    icon: "🤖",
    iconUrl: aiBotIconUrl,
    description: "对话式 AI；快捷指令仅自动拼装约定内容与导出摘录后发一条请求，可多轮追问。",
    component:
      __FEATURE_AI_AGENT__
        ? defineAsyncComponent(
            () => import("../features/ai-agent/AiAgentPanel.vue"),
          )
        : null,
    enabled: __FEATURE_AI_AGENT__,
    panelMode: "side",
  },
  {
    id: "voice-train",
    label: "声音训练",
    icon: "🎤",
    description: "选择音频训练专属声音模型，支持本地文件或歌曲库",
    component:
      __FEATURE_VOICE_CLONE__
        ? defineAsyncComponent(
            () => import("../features/voice-clone/VoiceTrainPlugin.vue"),
          )
        : null,
    enabled: __FEATURE_VOICE_CLONE__,
  },
];

/** Only plugins whose feature flag is on */
export function getEnabledPlugins(): PluginDescriptor[] {
  return ALL_PLUGINS.filter((p) => p.enabled && p.component);
}

/* ------------------------------------------------------------------ */
/*  Plugin event bus — open a plugin from anywhere with optional data  */
/* ------------------------------------------------------------------ */

export interface PluginOpenEvent {
  pluginId: string;
  /** Arbitrary payload forwarded to the plugin component */
  payload?: Record<string, unknown>;
}

type PluginOpenHandler = (evt: PluginOpenEvent) => void;
const handlers = new Set<PluginOpenHandler>();

/** Subscribe to plugin-open events (called by PluginHost) */
export function onPluginOpen(handler: PluginOpenHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** Request a plugin to open (called from any component) */
export function requestPluginOpen(pluginId: string, payload?: Record<string, unknown>): void {
  const evt: PluginOpenEvent = { pluginId, payload };
  for (const h of handlers) h(evt);
}

/**
 * Reactive ref holding the latest payload for each plugin.
 * The plugin component can watch this to receive data from external triggers.
 */
export const pluginPayloads = ref<Record<string, Record<string, unknown> | undefined>>({});

/**
 * Monotonically increasing counter — bumped every time a payload is written.
 * Plugin components can watch this instead of the payload object itself
 * to reliably detect new payloads (avoids Vue reactivity edge-cases with
 * undefined ↔ object transitions inside a ref).
 */
export const pluginPayloadVersion = ref(0);
