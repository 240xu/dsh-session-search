/**
 * dsh-session-search — 独立面板页（自持 HTML，零构建）。
 * 页面为静态模板：服务端零插值（无注入面）；动态内容全在浏览器端经
 * esc() 或 textContent 写入。样式走 --dsw 令牌并带深色 fallback。
 * @module dsh-session-search/panel
 */

export function panelHtml() {

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH 会话搜索</title>
<style>
  :root { color-scheme: dark; }
  body { font: 13px/1.5 ui-monospace, monospace; margin: 0; padding: 16px;
         background: var(--dsw-alias-bg-canvas, #11151c); color: var(--dsw-alias-label-primary, #d7dde6); }
  h1 { font-size: 16px; margin: 0 0 12px; }
  .bar { display: flex; gap: 8px; margin-bottom: 12px; }
  input { flex: 1; background: var(--dsw-alias-input-bg, #0d1117); color: inherit;
          border: 1px solid var(--dsw-alias-border-l1, #3a465a); border-radius: 6px; padding: 6px 10px; font: inherit; }
  button { background: var(--dsw-alias-interactive-bg, #2a3342); color: inherit; cursor: pointer;
           border: 1px solid var(--dsw-alias-border-l1, #3a465a); border-radius: 6px; padding: 6px 12px; font: inherit; }
  button:hover { background: var(--dsw-alias-interactive-bg-hover, #37435a); }
  .hit { background: var(--dsw-alias-bg-elevated, #161b24); border: 1px solid var(--dsw-alias-border-l1, #232a35);
         border-radius: 8px; margin: 8px 0; padding: 8px 12px; }
  .hit .role { color: var(--dsw-alias-warn, #fdd663); font-weight: 700; }
  .hit .meta { color: var(--dsw-alias-label-secondary, #9aa0a6); font-size: 11px; margin-bottom: 4px; word-break: break-all; }
  .hit .snippet { white-space: pre-wrap; word-break: break-word; }
  .hit .acts { margin-top: 6px; display: flex; gap: 6px; }
  .hit .acts button { font-size: 11px; padding: 2px 8px; }
  #status { color: var(--dsw-alias-label-tertiary, #9aa0a6); margin: 8px 0; }
  .err { color: var(--dsw-alias-danger, #f28b82); }
  code { color: var(--dsw-alias-info, #8ab4f8); }
</style>
</head>
<body>
<h1>dsh-session-search <span style="font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0a6)">read-only · 跨会话全文搜索</span></h1>
<div id="status" role="status" aria-live="polite">输入关键词搜索全部会话历史…</div>
<div class="bar">
  <input id="q" placeholder="搜索历史会话（大小写不敏感）" autofocus>
  <button id="go">搜索</button>
</div>
<div id="results"></div>
<script>
"use strict";
var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) {
  return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
}); };
var status = document.getElementById("status");
var results = document.getElementById("results");
function copyText(text, btn) {
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
    .then(function () { btn.textContent = "已复制"; setTimeout(function () { btn.textContent = "复制定位"; }, 1200); })
    .catch(function () { btn.textContent = "复制失败"; });
}
function run() {
  var q = document.getElementById("q").value.trim();
  if (!q) { status.textContent = "请输入关键词"; return; }
  status.textContent = "搜索中…";
  fetch("/api/session-search?q=" + encodeURIComponent(q) + "&limit=50")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data || !data.ok) throw new Error(data && data.error || "HTTP error");
      status.textContent = data.results.length
        ? "命中 " + data.results.length + " 条"
        : "无命中";
      results.innerHTML = data.results.map(function (h, i) {
        var loc = h.session.id + " #" + h.seq;
        return '<div class="hit">'
          + '<div class="meta">[' + esc(h.session.slug) + '] '
          + esc(h.session.title || h.session.id) + ' · seq ' + esc(h.seq) + ' · ' + esc(h.type) + '</div>'
          + '<div class="snippet">' + esc(h.snippet) + '</div>'
          + '<div class="acts"><button data-copy="' + i + '">复制定位</button>'
          + '<span style="font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0a6)"><code>' + esc(loc) + '</code> · 在主界面打开该会话后用 message-ops/消息列表定位到该 seq</span></div>'
          + '</div>';
      }).join("");
      Array.prototype.forEach.call(results.querySelectorAll("button[data-copy]"), function (btn) {
        var h = data.results[Number(btn.getAttribute("data-copy"))];
        btn.addEventListener("click", function () { copyText(h.session.id + " seq " + h.seq, btn); });
      });
    })
    .catch(function (e) { status.textContent = "搜索失败: " + e.message; status.className = "err"; });
}
document.getElementById("go").addEventListener("click", run);
document.getElementById("q").addEventListener("keydown", function (e) { if (e.key === "Enter") run(); });
</script>
</body>
</html>`;
}
