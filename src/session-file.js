/**
 * dsh-session-search — 会话日志帧读取（自包含，零 npm 依赖）。
 *
 * 与 dsh-message-ops 的 session-file.js 同源的多帧 zstd 读取实现
 * （有意复制保持插件自包含、不跨包 import）：DSH 会话日志 = 多个独立
 * zstd 帧串联，帧 0 = 恰一行 session header，其后每帧一批 NDJSON 事件。
 * 帧扫描按魔数定位（与宿主/其它 @240xu 插件一致的已知取舍，见 README）。
 * 本插件只读：对 ~/.dsh/sessions 零写入。
 * @module dsh-session-search/session-file
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

const ZSTD_MAGIC = 0xfd2fb528;

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 扫描串联 zstd 流的完整帧边界（不解压块）。
 * @returns {{frames: {start:number,end:number}[], tornStart?: number}}
 */
function scanZstdFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    const start = offset;
    if (buf.length - offset < 4) return { frames, tornStart: start };
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt zstd session log: invalid frame magic at byte ${offset}`);
    }
    let end = buf.length;
    for (let p = offset + 4; p <= buf.length - 4; p++) {
      if (buf.readUInt32LE(p) === ZSTD_MAGIC) { end = p; break; }
    }
    frames.push({ start, end });
    offset = end;
  }
  return { frames };
}

/** 同步整读（header + 事件）。小文件 / 测试用。 */
export function readSessionFile(file) {
  const buf = fs.readFileSync(file);
  const { frames } = scanZstdFrames(buf);
  if (frames.length === 0) throw new Error("empty or header-less session log");
  const headerText = zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString("utf8");
  const header = JSON.parse(headerText.trim());
  if (header.type !== "session") throw new Error("first frame is not a session header");
  const events = [];
  for (const f of frames.slice(1)) {
    const text = zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { events.push(JSON.parse(t)); } catch { /* torn record: skip */ }
    }
  }
  return { header, events };
}

/**
 * 异步逐帧读取：每 framesPerYield 帧 setImmediate 让出一次事件循环
 * （首次全量索引大会话不阻塞 GUI）。撕裂尾帧按完整前缀语义忽略。
 * @returns {{header, events, frameCount}}
 */
export async function readSessionFileAsync(file, { framesPerYield = 8 } = {}) {
  const buf = fs.readFileSync(file);
  const { frames } = scanZstdFrames(buf);
  if (frames.length === 0) throw new Error("empty or header-less session log");
  const headerText = zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString("utf8");
  const header = JSON.parse(headerText.trim());
  if (header.type !== "session") throw new Error("first frame is not a session header");
  const events = [];
  const bodyFrames = frames.slice(1);
  let sinceYield = 0;
  for (const f of bodyFrames) {
    const text = zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { events.push(JSON.parse(t)); } catch { /* torn record: skip */ }
    }
    if (++sinceYield >= framesPerYield) { sinceYield = 0; await yieldToLoop(); }
  }
  return { header, events, frameCount: bodyFrames.length };
}

/** 从 message 事件提取首个非空 text 块。 */
export function messageText(e) {
  const msg = e && e.data && e.data.message;
  const content = msg && Array.isArray(msg.content) ? msg.content : (e && e.data && e.data.content);
  if (!Array.isArray(content)) return "";
  for (const c of content) {
    if (c && c.type === "text" && typeof c.text === "string" && c.text.trim()) return c.text;
  }
  return "";
}

// --- 索引缓存目录（对 sessions 零写入；缓存放 $DSH_HOME/cache/） --------------

const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sessionsRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "sessions");
}

export function cacheRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "cache", "session-search");
}

/**
 * 发现全部会话日志：{slug, id, logPath, mtime, size}[]。
 * slug = sessions 根下的 project 目录名（用于 project 过滤）。
 */
export function discoverSessionLogs() {
  const root = sessionsRoot();
  let slugs = [];
  try { slugs = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    let ids = [];
    try { ids = fs.readdirSync(path.join(root, slug.name), { withFileTypes: true }); } catch { continue; }
    for (const id of ids) {
      if (!id.isDirectory()) continue;
      if (!SESSION_ID_RE.test(id.name)) continue;
      const logPath = path.join(root, slug.name, id.name, "session.v3.jsonl.zstd");
      let st;
      try { st = fs.statSync(logPath); } catch { continue; }
      out.push({ slug: slug.name, id: id.name, logPath, mtime: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

/** 测试/复用：写一份最小会话日志（真实 zstd 格式）。 */
export function writeSessionLog(dir, header, events) {
  fs.mkdirSync(dir, { recursive: true });
  const compress = (s) => zstdCompressSync(Buffer.from(s, "utf8"), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
  const buf = Buffer.concat([
    compress(JSON.stringify(header) + "\n"),
    compress(events.map((e) => JSON.stringify(e)).join("\n") + "\n"),
  ]);
  const logPath = path.join(dir, "session.v3.jsonl.zstd");
  fs.writeFileSync(logPath, buf);
  const st = fs.statSync(logPath);
  return { logPath, mtime: st.mtimeMs, size: st.size };
}
