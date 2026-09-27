/**
 * dsh-session-search — HTTP 信任围栏（自包含复制自 dsh-message-ops/ops-core.js，
 * arch-review 的上线硬门槛：插件经 webServer.register 挂载的路由不经过宿主
 * connection RPC 面的围栏）。三层：回环 Host 挡 DNS rebinding +
 * sec-fetch-site: cross-site 拒绝 + Origin 同源校验。
 * @module dsh-session-search/fence
 */

function headerOf(headers, name) {
  const value = headers && headers[name];
  return typeof value === "string" ? value : undefined;
}

function parseAuthority(authority) {
  try { return new URL(`http://${authority}`); } catch { return undefined; }
}

function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

export function isTrustedApiRequest(req) {
  const host = headerOf(req && req.headers, "host");
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname)) return false;
  if (headerOf(req.headers, "sec-fetch-site") === "cross-site") return false;
  const origin = headerOf(req.headers, "origin");
  if (origin === undefined) return true;
  try { return new URL(origin).host === hostUrl.host; } catch { return false; }
}
