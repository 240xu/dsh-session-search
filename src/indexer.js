/**
 * dsh-session-search — 增量索引器（纯 Node，零 npm 依赖）。
 *
 * 对 ~/.dsh/sessions 全部会话日志建立消息级全文索引：
 *   - 每条 user/assistant/system message 记 {seq, type, text(截500字符)}；
 *   - 持久化到 $DSH_HOME/cache/session-search/index.json（原子写 tmp+rename；
 *     对 sessions 目录零写入，缓存目录是唯一写点）；
 *   - 增量判定：会话日志 mtimeMs+size 与缓存一致则跳过重扫；
 *   - 首次全量构建大会话走 readSessionFileAsync 的帧间让出。
 *
 * 性能取舍（见 README）：全量倒排/分词不做了，索引就是「会话 → 消息条目」
 * 的轻量投影，检索用大小写不敏感的 indexOf 线性扫描（防 ReDoS；对数千会话
 * ×数百条消息的本地规模，扫内存数组是亚秒级，换 Lucene 级索引不值当）。
 * @module dsh-session-search/indexer
 */

import fs from "node:fs";
import path from "node:path";
import { cacheRoot, discoverSessionLogs, readSessionFileAsync, messageText, computeShadowed } from "./session-file.js";

const TEXT_LIMIT = 500;

/** 单会话索引条目（msg 级）。 */
function messagesOf(events) {
  const out = [];
  // 0.1.7：**被回滚遮蔽的消息不进索引**（专家组评估的隐私缺口 #3）。
  // 遮蔽由 append-only 的 surface replace marker 表达；恢复则以新 seq 追加重放副本，
  // 新副本不在 replace 区间内 → 恢复后照常可搜、且不会与死本重复（死本已滤掉）。
  // 任一 revert/restore 都会 append 日志 → mtime+size 变化 → 增量重建必然重算本集合，
  // 不存在「缓存里留着旧遮蔽集」的陈旧窗口（缓存版本见 loadCache 的 version）。
  const shadowed = computeShadowed(events);
  for (const e of events) {
    if (!e || typeof e.seq !== "number") continue;
    if (e.type !== "user/message" && e.type !== "assistant/message" && e.type !== "system/message") continue;
    if (shadowed.has(e.seq)) continue;
    const text = messageText(e);
    if (!text) continue;
    out.push({ seq: e.seq, type: e.type, text: text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) : text });
  }
  return out;
}

function loadCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(cacheRoot(), "index.json"), "utf8"));
    // 0.1.5（P1）：typeof null === 'object'——原校验接受 {"sessions":null}，
    // 首条 refresh 读 this.cache.sessions[key] 同步 TypeError → 与上同款毒化
    // 0.1.7：version 1→2 —— 旧缓存是**未过滤遮蔽消息**的索引，直接复用会让
    // 已回滚内容继续可搜（隐私缺口本身修不掉）。跳过 version 校验即全量重建。
    if (raw && raw.version === 2 && raw.sessions && typeof raw.sessions === "object" && !Array.isArray(raw.sessions)) return raw;
  } catch { /* absent/corrupt → rebuild */ }
  return { version: 2, builtAt: 0, sessions: {} };
}

/** 原子写：tmp + rename（同目录保证同一文件系统）。 */
function saveCache(cache) {
  const dir = cacheRoot();
  fs.mkdirSync(dir, { recursive: true });
  cache.builtAt = Date.now();
  const tmp = path.join(dir, `index.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, path.join(dir, "index.json"));
}

/** 内存态索引（HTTP / 工具共用，增量刷新）。 */
export class SessionIndex {
  constructor() {
    this.cache = loadCache();
    this.scanning = null; // 进行中的刷新 Promise（并发请求合并）
  }

  /**
   * 增量刷新：mtime+size 未变的会话直接复用缓存；变更/新增的重扫。
   * @param {{onLog?: (line: string) => void}} opts 进度回调（可选）
   * @returns {{scanned:number, skipped:number, removed:number, total:number}}
   */
  async refresh({ onLog } = {}) {
    if (this.scanning) return this.scanning;
    // 0.1.5（P1 修复）：原实现把 async IIFE 直接赋给 this.scanning——IIFE 在首个
    // await 前同步抛出（saveCache ENOSPC / 坏缓存 sessions:null 读属性）时，
    // 内层 finally 的 this.scanning=null 先于赋值执行，随后 rejected promise 被
    // 永久挂上 → 此后所有 refresh 永远返回同一个 rejected promise，索引到进程重启
    // 前全部 500，且毒化后 saveCache 永不执行、坏缓存无法自愈。
    // 正确顺序：先赋值，再在外部挂 finally（且吞掉 finally 链自身的 rejection，
    // 调用方仍通过返回的 p 收到原始 rejection）。
    const scanPromise = (async () => {
      {
        const logs = discoverSessionLogs();
        const seen = new Set();
        let scanned = 0, skipped = 0;
        for (const entry of logs) {
          const key = `${entry.slug}/${entry.id}`;
          seen.add(key);
          const cached = this.cache.sessions[key];
          if (cached && cached.mtime === entry.mtime && cached.size === entry.size) { skipped++; continue; }
          try {
            const { header, events } = await readSessionFileAsync(entry.logPath);
            this.cache.sessions[key] = {
              id: header.id || entry.id,
              slug: entry.slug,
              title: typeof header.title === "string" ? header.title : null,
              parentSession: header.parentSession ?? null,
              mtime: entry.mtime,
              size: entry.size,
              messages: messagesOf(events),
            };
            scanned++;
            if (onLog) onLog(`indexed ${key} (${this.cache.sessions[key].messages.length} messages)`);
          } catch (err) {
            // 坏帧/撕裂日志：保留旧缓存（如有），跳过该会话
            if (onLog) onLog(`skip ${key}: ${err && err.message}`);
            if (!cached) delete this.cache.sessions[key];
          }
        }
        let removed = 0;
        for (const key of Object.keys(this.cache.sessions)) {
          if (!seen.has(key)) { delete this.cache.sessions[key]; removed++; }
        }
        // 0.1.5（P2）：零变更不重写 index.json——GET /api/session-search 每次都先
        // await refresh()，大索引下无条件同步 stringify+write 会阻塞事件循环
        if (scanned > 0 || removed > 0) saveCache(this.cache);
        return { scanned, skipped, removed, total: Object.keys(this.cache.sessions).length };
      }
    })();
    this.scanning = scanPromise;
    scanPromise.finally(() => {
      if (this.scanning === scanPromise) this.scanning = null;
    }).catch(() => { /* finally 链自吞——原始 rejection 由 scanPromise 返回给调用方 */ });
    return scanPromise;
  }

  /**
   * 搜索：大小写不敏感子串（indexOf，防 ReDoS）。按会话 mtime 新→旧排序。
   * @param {string} q 查询串（trim 后为空返回 []）
   * @param {{limit?:number, project?:string, returnMeta?:boolean}} opts
   *   returnMeta=true 时返回 {hits, capped}：capped 仅当 limit 被钳到 100
   *   封顶且真实命中 > 封顶（探测多收 1 条判定）——普通 limit 截断不算。
   *   默认（false）保持原数组返回形态，既有调用方零改动。
   * @returns {Array<{session:{id,slug,title}, seq, type, snippet}> | {hits, capped}}
   */
  search(q, { limit = 20, project, returnMeta = false } = {}) {
    const needle = String(q == null ? "" : q).trim().toLowerCase();
    if (!needle) return returnMeta ? { hits: [], capped: false } : [];
    const requested = Number.isSafeInteger(limit) && limit > 0 ? limit : 20;
    const lim = Math.min(requested, 100);
    // 封顶探测：limit 被 100 钳制时多收 1 条 —— 收满 lim+1 条即证明真实
    // 命中 > 封顶值，capped:true；真实命中恰好 ≤ 封顶值则 capped 不置位。
    const cap = requested > lim ? lim + 1 : lim;
    const entries = Object.values(this.cache.sessions)
      .filter((s) => (project ? s.slug === project : true))
      .sort((a, b) => b.mtime - a.mtime);
    const hits = [];
    for (const s of entries) {
      for (const m of s.messages) {
        const idx = m.text.toLowerCase().indexOf(needle);
        if (idx === -1) continue;
        const from = Math.max(0, idx - 60);
        const to = Math.min(m.text.length, idx + needle.length + 60);
        hits.push({
          session: { id: s.id, slug: s.slug, title: s.title ?? null },
          seq: m.seq,
          type: m.type,
          snippet: (from > 0 ? "…" : "") + m.text.slice(from, to) + (to < m.text.length ? "…" : ""),
        });
        if (hits.length >= cap) break;
      }
      if (hits.length >= cap) break;
    }
    const capped = hits.length > lim;
    const out = capped ? hits.slice(0, lim) : hits;
    return returnMeta ? { hits: out, capped } : out;
  }
}
