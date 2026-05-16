/**
 * Google list models 会混入不适配「OpenAI 兼容 + 文本流」/chat 的条目，例如：
 * - 仅 AUDIO/TTS 输出模态
 * - robotics-er 等专用预览（列表可能仍返回，但聊天端已 404 / 不适用通用正文）
 */
export function geminiEligibleForOpenAiCompatTextChat(id) {
  const s = String(id || "").toLowerCase();
  if (!s.startsWith("gemini")) return true;
  if (/tts/i.test(s)) return false;
  if (/robotics-er/i.test(s)) return false;
  return true;
}
