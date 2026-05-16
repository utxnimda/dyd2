/**supabaseUrl：Supabase 项目 Project URL
 * supabaseAnonKey：anon public API Key（Project Settings → API）
 * 留空则前台使用本地演示数据；管理后台 (admin.html) 必须填写二者才能登录。
 * awardsFeedUrl：可选，获奖 JSON 地址（见 awards.html）。
 * 相册若提示缺少审核字段：在 SQL Editor 执行 supabase/gallery_approval_migration.sql。
 *
 * ── 点歌后「发邮件给管理员」两种接法（二选一或同时用）──
 *
 * 【A】notifyPickWebhookUrl（推荐入门）
 * 填一个 HTTPS 地址，访客点歌上报成功后会 POST 表单字段（application/x-www-form-urlencoded）：
 *   event=song_pick & song_id=… & song_title=… & song_artist=… & visitor_id=… & reported_at=ISO时间
 * 典型用法：Zapier「Webhooks by Zapier」Catch Hook → Gmail「发送邮件」；
 * 或 Make、n8n、自建小服务接收后转发邮箱。URL 勿提交到公开仓库时可改用环境变量构建。
 *
 * 【B】Resend 发信（专业）
 * 1) 注册 Resend，取 API Key；在 Resend 中配置发件域名（测试可用 onboarding@resend.dev，仅可发到本人邮箱）。
 * 2) 本地安装 Supabase CLI，在项目 supabase 目录部署函数：supabase functions deploy song-pick-email
 * 3) 设置密钥：RESEND_API_KEY、PICK_NOTIFY_EMAIL（收件人）、可选 RESEND_FROM、PICK_WEBHOOK_SECRET
 * 4) Supabase 控制台 → Database → Webhooks：表 song_pick_requests、事件 INSERT，URL 填
 *    https://<项目ref>.supabase.co/functions/v1/song-pick-email
 *    若设置了 PICK_WEBHOOK_SECRET，请增加 HTTP Header：x-webhook-secret: 与密钥相同
 * 详见 supabase/functions/song-pick-email/index.ts 与 supabase/config.toml
 */
window.JUKEBOX_CONFIG = {
  supabaseUrl: "",
  supabaseAnonKey: "",
  /** 可选：返回 JSON 数组的 HTTPS 地址，需目标站开启 CORS。项字段示例：title, detail, source_url, awarded_at */
  awardsFeedUrl: "",
  /** 可选：点歌上报成功后 POST 通知（见文件头说明）。Zapier Catch Hook 等 HTTPS 地址。 */
  notifyPickWebhookUrl: "",
};