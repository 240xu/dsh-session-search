/**
 * dsh-session-search 服务端：跨会话全文搜索。
 *
 *   GET /api/session-search?q=&limit=20&project=<slug 可选>   搜索 API
 *   GET /api/session-search/panel                             独立 HTML 面板页
 *   POST /api/session-search/refresh                          手动触发增量刷新
 *
 * 硬约束：对 ~/.dsh/sessions 零写入（索引缓存存 $DSH_HOME/cache/session-search/）；
 * 侧边栏零触碰（无任何 sidebar 注册面，UI 即本插件的独立面板页，
 * devkit 可注册「搜索会话历史」命令指向 panel URL——由 Lead 接线）。
 * 信任围栏（arch-review L4/L5 硬门槛）：全部路由先过 isTrustedApiRequest
 * （回环 Host 挡 DNS rebinding + sec-fetch-site 拒绝 + Origin 同源），
 * 实现自包含复制自 dsh-message-ops 的 ops-core.js。
 * Agent 工具 session_search：容错注册（tools 服务缺失或 @deepseek-ai/dsh-tools
 * 不可解析时只跳过工具，HTTP 面不受影响）——同 message-ops 模式。
 * @module dsh-session-search
 */

import { SessionIndex } from "./indexer.js";
import { isTrustedApiRequest } from "./fence.js";
import { panelHtml } from "./panel.js";

export const name = "dsh-session-search";
// tools 是可选增强（cordis inject 是硬依赖声明）：保持 inject 为空，apply 内容错探测。
export const inject = [];

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function readFencedQuery(req, res, url) {
  if (!isTrustedApiRequest(req)) {
    sendJson(res, 403, { ok: false, error: "untrusted request origin (loopback Host + same-origin only)" });
    return null;
  }
  return url;
}

const sharedIndex = new SessionIndex();

function registerHttp(host, targetCtx) {
  // --- GET 搜索（围栏后索引懒刷新：首次请求即建索引） ------------------------
  targetCtx.effect(() => host.register({
    kind: "exact",
    path: "/api/session-search",
    handler: async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (!readFencedQuery(req, res, url)) return;
      try {
        const q = url.searchParams.get("q") || "";
        const limit = Number(url.searchParams.get("limit")) || undefined;
        const project = url.searchParams.get("project") || undefined;
        await sharedIndex.refresh();
        const results = sharedIndex.search(q, { limit, project });
        return sendJson(res, 200, { ok: true, q, count: results.length, results });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
      }
    },
  }), "dsh-session-search: search route");

  // --- POST 手动刷新（写方法围栏：Content-Type 必须 application/json） -------
  targetCtx.effect(() => host.register({
    kind: "exact",
    path: "/api/session-search/refresh",
    handler: async (req, res) => {
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" });
      if (!isTrustedApiRequest(req)) {
        return sendJson(res, 403, { ok: false, error: "untrusted request origin (loopback Host + same-origin only)" });
      }
      const ct = String(req.headers && req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (ct !== "application/json") {
        return sendJson(res, 415, { ok: false, error: "content-type must be application/json" });
      }
      try {
        return sendJson(res, 200, { ok: true, ...(await sharedIndex.refresh()) });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
      }
    },
  }), "dsh-session-search: refresh route");

  // --- GET 独立面板页（自持 HTML；esc() 一切插值） ---------------------------
  targetCtx.effect(() => host.register({
    kind: "exact",
    path: "/api/session-search/panel",
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req)) {
        return sendJson(res, 403, { ok: false, error: "untrusted request origin" });
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(panelHtml());
    },
  }), "dsh-session-search: panel route");
}

// ---------------------------------------------------------------------------
// 独立面板页：搜索框 + 结果列表；esc() 一切插值；--dsw 令牌 + 深色 fallback。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Agent 工具 session_search（容错注册，同 message-ops 模式）
// ---------------------------------------------------------------------------

function registerToolTolerantly(ctx) {
  function tryRegister(targetCtx) {
    const tools = targetCtx.get("tools");
    if (!tools || typeof tools.register !== "function") return false;
    import("@deepseek-ai/dsh-tools")
      .then(({ defineTool }) => {
        tools.register(defineTool({
          name: "session_search",
          description:
            "Full-text search across ALL persisted DSH session logs (user/assistant/system messages). Case-insensitive substring match, results ordered by session recency. Use to find past conversations by keyword.",
          parameters: {
            q: { type: "string", required: true, description: "Search keywords (substring, case-insensitive)." },
            limit: { type: "integer", description: "Max results (1-100, default 20)." },
            project: { type: "string", description: "Optional project slug filter (the directory name under ~/.dsh/sessions)." },
          },
          output: {
            schema: { type: "string" },
            render(_args, value) { return [{ type: "text", text: value }]; },
          },
          async execute(args) {
            try {
              await sharedIndex.refresh();
              const results = sharedIndex.search(args.q, { limit: args.limit, project: args.project });
              if (results.length === 0) return `no hits for: ${args.q}`;
              return results.map((h) =>
                `[${h.session.slug}] ${h.session.title || h.session.id} seq ${h.seq} (${h.type}): ${h.snippet}`
              ).join("\n");
            } catch (e) {
              return `search failed: ${e && e.message ? e.message : e}`;
            }
          },
        }));
      })
      .catch(() => { /* dsh-tools 不可解析：跳过工具注册，不影响 HTTP 面 */ });
    return true;
  }
  if (tryRegister(ctx)) return;
  ctx.inject(["tools"], (sub) => { tryRegister(sub); });
}

export function apply(ctx) {
  const ws = ctx.get("webServer");
  if (ws !== undefined) registerHttp(ws, ctx);
  else ctx.inject(["webServer"], (sub) => registerHttp(sub.webServer, sub));
  registerToolTolerantly(ctx);
}

export default { name, inject, apply };
