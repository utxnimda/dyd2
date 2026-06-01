/**
 * release/opt 后端目录与 fmzFeatures 的对应关系。
 * pack-release.mjs 与 deploy.mjs 共用，避免打包/停服逻辑漂移。
 */

/** @type {Array<{ remoteName: string; include: (f: Record<string, unknown>) => boolean; copies: [string, string][] }>} */
export const OPT_RELEASE_BUNDLES = [
  {
    remoteName: "fmz-danmaku-server",
    include: (f) => f.douyuDanmaku === true || f.dreamBus === true,
    copies: [
      ["server/douyu-danmaku-server.mjs", "douyu-danmaku-server.mjs"],
      ["server/dream-bus-store.mjs", "dream-bus-store.mjs"],
      ["server/gemini-openai-compat-chat-filter.mjs", "gemini-openai-compat-chat-filter.mjs"],
      ["server/fmz-ai-gateway-client.mjs", "fmz-ai-gateway-client.mjs"],
      ["server/fmz-remote-service-auth.mjs", "fmz-remote-service-auth.mjs"],
    ],
  },
  {
    remoteName: "fmz-ai-agent-server",
    include: (f) => f.aiAgent === true,
    copies: [
      ["server/ai-agent-server.mjs", "ai-agent-server.mjs"],
      ["server/fmz-remote-service-auth.mjs", "fmz-remote-service-auth.mjs"],
      ["server/gemini-openai-compat-chat-filter.mjs", "gemini-openai-compat-chat-filter.mjs"],
      ["deploy/fmz-ai-agent-server.package.json", "package.json"],
    ],
  },
  {
    remoteName: "fmz-voice-clone-server",
    include: (f) => f.voiceClone === true,
    copies: [
      ["server/voice-clone-server.mjs", "voice-clone-server.mjs"],
      ["server/fmz-remote-service-auth.mjs", "fmz-remote-service-auth.mjs"],
    ],
  },
  {
    remoteName: "fmz-audio-server",
    include: (f) => f.audio === true,
    copies: [["server/audio-extractor-server.mjs", "audio-extractor-server.mjs"]],
  },
  {
    remoteName: "fmz-crimes-server",
    include: (f) => f.crimes === true,
    copies: [["server/crimes-server.mjs", "crimes-server.mjs"]],
  },
  {
    remoteName: "fmz-defense-server",
    /** 仅线上发布守塔 UI 时才需要后端 */
    include: (f) => f.sanguo === true && f.sanguoUi === true,
    copies: [
      ["server/defense-tower-server.mjs", "defense-tower-server.mjs"],
      ["server/package.json", "package.json"],
    ],
  },
  {
    remoteName: "fmz-reactions-server",
    include: (f) =>
      f.battle === true || f.treasury === true || f.preliminary === true || f.users === true,
    copies: [
      ["server/reactions-server.mjs", "reactions-server.mjs"],
      ["server/package.json", "package.json"],
    ],
  },
];

/** release/opt/<dir>/ → systemd 单元名 */
export const OPT_TO_SYSTEMD = {
  "fmz-danmaku-server": "fmz-danmaku",
  "fmz-ai-agent-server": "fmz-ai-agent",
  "fmz-voice-clone-server": "fmz-voice-clone",
  "fmz-audio-server": "fmz-audio",
  "fmz-crimes-server": "fmz-crimes",
  "fmz-defense-server": "fmz-defense",
  "fmz-reactions-server": "fmz-reactions",
};

/** 按 fmzFeatures 应上线的 opt 目录名 */
export function optRemoteNamesForFeatures(features = {}) {
  return OPT_RELEASE_BUNDLES.filter((b) => b.include(features)).map((b) => b.remoteName);
}

/** 按 fmzFeatures 应运行的 systemd 单元 */
export function systemdUnitsForFeatures(features = {}) {
  return optRemoteNamesForFeatures(features)
    .map((name) => OPT_TO_SYSTEMD[name])
    .filter(Boolean);
}

/** 远端应 stop + disable 的单元（未纳入当前特性） */
export function systemdUnitsToStop(features = {}) {
  const active = new Set(systemdUnitsForFeatures(features));
  return Object.values(OPT_TO_SYSTEMD).filter((unit) => !active.has(unit));
}
