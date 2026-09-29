/**
 * runtime-harness.mjs — 真实运行时实测壳（非 mock）。
 *
 * 用 node:http 提供最小 webServer host 垫片，把 dsh-session-search 的真实
 * apply()（含信任围栏、索引器、面板页）、dsh-devkit 的服务端路由与
 * dsh-websearch 的 history 路由挂到 127.0.0.1:3999，数据面直连真实
 * $DSH_HOME（~/.dsh/sessions 的 v4/v3/legacy 日志 + 各自 cache 目录）。
 * 仅用于 runtime-verification 实测，不进 npm files。
 *
 * 用法：node scripts/runtime-harness.mjs [port]
 */
import http from "node:http";
import { apply as sessionSearchApply } from "../src/index.js";
import devkitApply from "../../dsh-devkit/src/index.js";
import { createHistoryStore, registerHistoryRoutes } from "../../dsh-websearch/lib/history.js";
import { resolveStoreDir } from "../../dsh-websearch/lib/index.js";

const routes = new Map();
const webServer = {
  register(route) {
    if (route && route.kind === "exact" && typeof route.handler === "function") {
      routes.set(route.path, route.handler);
    }
  },
};

// session-search：真实 apply（索引器 + 围栏 + 面板 + 容错工具注册）
sessionSearchApply({ get: (k) => (k === "webServer" ? webServer : undefined), inject() {}, effect(fn) { return fn(); } });

// devkit：服务端 apply（commands/health 只依赖 webServer）
try { devkitApply.apply ? devkitApply.apply({ get: (k) => (k === "webServer" ? webServer : undefined), inject() {}, effect(fn) { return fn(); } }) : null; }
catch (e) { console.error("[harness] devkit apply failed:", e.message); }

// websearch：真实 history store（~/.dsh/cache/websearch/history.json）+ 真实路由
try {
  const store = createHistoryStore({ dir: resolveStoreDir(), maxEntries: 50 });
  registerHistoryRoutes(webServer, { getStore: () => store });
} catch (e) { console.error("[harness] websearch history failed:", e.message); }

const port = Number(process.argv[2]) || 3999;
http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const handler = routes.get(url.pathname);
  if (!handler) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "no route" })); return; }
  Promise.resolve(handler(req, res)).catch((e) => {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: String(e && e.message) }));
  });
}).listen(port, "127.0.0.1", () => {
  console.log(`[harness] listening on http://127.0.0.1:${port} with routes:`);
  for (const p of routes.keys()) console.log("  ", p);
});
