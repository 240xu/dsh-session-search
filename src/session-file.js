/**
 * dsh-session-search — 会话日志帧读取（自包含，零 npm 依赖）。
 *
 * 与 dsh-message-ops 的 session-file.js 同源的多帧 zstd 读取实现
 * （有意复制保持插件自包含、不跨包 import）：DSH 会话日志 = 多个独立
 * zstd 帧串联，帧 0 = 恰一行 session header，其后每帧一批 NDJSON 事件。
 * 格式代际：v4（session.v4.jsonl.zstd，当前 cohort）与 v3 帧结构完全
 * 同构，仅文件名/header.version 数字不同，读取端统一兼容（legacy 单帧
 * 历史上 header.version 为 0，一并放行）；旧格式
 * session.jsonl.zstd（legacy 单帧整文件）= 解压后首行 header、其余行
 * 事件，走同一条解析路径（单帧等效于解压整份）。
 * 帧扫描按魔数定位（与宿主/其它 @240xu 插件一致的已知取舍，见 README）。
 * 本插件只读：对 ~/.dsh/sessions 零写入。
 * @module dsh-session-search/session-file
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

const ZSTD_MAGIC = 0xfd2fb528;
/** 魔数的字节形态（Buffer.indexOf 用；小端 0xfd2fb528 → 28 b5 2f fd）。 */
const ZSTD_MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * surface replace 遮蔽区的同步 span 上限（M1 护栏）。
 * 正常会话的 replace 区间至多几百 seq；超过此值的 marker 只能是损坏日志/
 * 恶意构造 —— 原实现 `for (s = startSeq; s <= endSeq; s++)` 无上界，
 * start=0/end=2^53 的假 marker 会把事件循环卡死数小时（OOM 级 DoS）。
 * 注意：这是**本插件有意扩展的护栏**，dsh-message-ops 的 computeShadowed
 * 没有它 —— 巨大 span 下两实现行为不同（这里抛错跳过该会话，
 * 源实现会全量 add），防漂移锁的等值断言只覆盖双方共同域（span ≤ 本上限）。
 */
const MAX_SPAN = 1_000_000;

/** OpsError 风格错误（带语义状态码；本插件自包含，不跨包 import）。 */
class SessionFileError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** 会话代际：v4 与 v3 帧结构同构；legacy 单帧历史上以 version 0 落盘。 */
const KNOWN_VERSIONS = new Set([0, 3, 4]);

/**
 * 校验会话 header 代际：v3/v4（以及缺省 version 的 legacy）都接受。
 * @throws 明确报出未知代际（fail loud，避免静默按错误结构解析）。
 */
function assertKnownVersion(header) {
  const v = header?.version;
  if (v === undefined || KNOWN_VERSIONS.has(v)) return;
  // 0.1.6（P2）：分代际处置——正整数 ≥5 = 未来代际，从 throw 降为 warn+接受
  // （throw 会让该会话 per-session skip 且无 degraded 信号，dsh 发 v5 后全部
  // 会话静默断索引；帧结构 best-effort + 显式告警优于静默丢弃）；
  // 1/2/负数/非整数 = 损坏头，保持 fail loud（守住解析安全）。
  if (Number.isInteger(v) && v >= 5) {
    console.warn(`[dsh-session-search] session log version ${v} is newer than known (0/3/4) — best-effort indexing; if text looks wrong, update KNOWN_VERSIONS`);
    return;
  }
  throw new Error(`unsupported session log version: ${v} (known: 0/legacy, 3, 4)`);
}

/** 把一段 NDJSON 文本解析为事件数组（撕裂行跳过）。 */
function parseEventLines(text) {
  const events = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch { /* torn record: skip */ }
  }
  return events;
}

/**
 * legacy 单帧（session.jsonl.zstd）：解压文本 = 首行 header + 其余行事件。
 * @returns {{header: object, events: object[]}}
 */
function parseLegacySingleFrame(text) {
  const nl = text.indexOf("\n");
  if (nl === -1) throw new Error("legacy single-frame log has no header line");
  const header = JSON.parse(text.slice(0, nl).trim());
  if (header.type !== "session") throw new Error("first line is not a session header");
  assertKnownVersion(header);
  return { header, events: parseEventLines(text.slice(nl + 1)) };
}

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 扫描串联 zstd 流的完整帧边界（不解压块）。
 *
 * 找「下一个魔数」用 Buffer.indexOf（原生 memchr 实现）而不是逐字节
 * readUInt32LE 循环 —— 10.8MB 日志的逐字节扫描实测 44~73ms 且全程同步
 * 阻塞事件循环（单次卡顿 146ms 的主要来源）；indexOf 同样从 offset+4
 * 起找、同样要求 4 字节完整落在缓冲区内，语义与原循环**逐位等价**
 * （命中区间 [offset+4, buf.length-4]，找不到则 end=buf.length）。
 * 等值由 test/session-shadowed.test.js 的 scanZstdFrames 防漂移锁保证。
 * @returns {{frames: {start:number,end:number}[], tornStart?: number}}
 */
export function scanZstdFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    const start = offset;
    if (buf.length - offset < 4) return { frames, tornStart: start };
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt zstd session log: invalid frame magic at byte ${offset}`);
    }
    let end = buf.length;
    const found = buf.indexOf(ZSTD_MAGIC_BYTES, offset + 4);
    if (found !== -1) end = found;
    frames.push({ start, end });
    offset = end;
  }
  return { frames };
}

/** 同步整读（header + 事件）。小文件 / 测试用。v3/v4/legacy 单帧通吃。 */
export function readSessionFile(file) {
  const buf = fs.readFileSync(file);
  const { frames } = scanZstdFrames(buf);
  if (frames.length === 0) throw new Error("empty or header-less session log");
  const frame0Text = zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString("utf8");
  if (frames.length === 1) return parseLegacySingleFrame(frame0Text);
  const header = JSON.parse(frame0Text.trim());
  if (header.type !== "session") throw new Error("first frame is not a session header");
  assertKnownVersion(header);
  const events = [];
  for (const f of frames.slice(1)) {
    events.push(...parseEventLines(zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8")));
  }
  return { header, events };
}

/**
 * 异步逐帧读取：每 framesPerYield 帧 setImmediate 让出一次事件循环
 * （首次全量索引大会话不阻塞 GUI）。撕裂尾帧按完整前缀语义忽略。
 * @returns {{header, events, frameCount}}
 */
export async function readSessionFileAsync(file, { framesPerYield = 8 } = {}) {
  // 与 dsh-message-ops 同款：文件读取走 fs.promises.readFile（线程池，
  // 不阻塞事件循环 —— 10.8MB 的 readFileSync 是 19ms 的额外同步阻塞）。
  const buf = await fs.promises.readFile(file);
  const { frames } = scanZstdFrames(buf);
  if (frames.length === 0) throw new Error("empty or header-less session log");
  const frame0Text = zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString("utf8");
  if (frames.length === 1) {
    // legacy 单帧：一次解压即整份，无需让出
    return { ...parseLegacySingleFrame(frame0Text), frameCount: 1 };
  }
  const header = JSON.parse(frame0Text.trim());
  if (header.type !== "session") throw new Error("first frame is not a session header");
  assertKnownVersion(header);
  const events = [];
  const bodyFrames = frames.slice(1);
  let sinceYield = 0;
  for (const f of bodyFrames) {
    events.push(...parseEventLines(zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8")));
    if (++sinceYield >= framesPerYield) { sinceYield = 0; await yieldToLoop(); }
  }
  return { header, events, frameCount: bodyFrames.length };
}

/** 从 message 事件提取首个非空 text 块。 */
/**
 * 被「消息回滚」遮蔽的 seq 集合 —— 自包含复制自 dsh-message-ops/session-file.js
 * 的 `readReplaceOp` + `computeShadowed`（与本文件其余 zstd 读取同源复制的同一约定）。
 *
 * 为什么不是 import：本插件刻意零 npm 依赖（package.json `dependencies` 为空），
 * 见 src/index.js / src/fence.js 文件头「自包含复制」约定。**改这两处必须同步改
 * dsh-message-ops**，防漂移由 test/session-shadowed.test.js 的 computeShadowed
 * 等值锁保证（两边跑同一批事件断言集合完全相同）。
 *
 * 语义：surface replace 遮蔽 [startSeq..endSeq] —— append-only 日志里原 seq 仍在，
 * 但**用户已回滚，不应出现在搜索结果里**。恢复是「以新 seq 追加重放副本」，
 * 新副本不在任何 replace 区间内，因此**恢复后仍能搜到**（且不会与死本重复，
 * 死本已被过滤）。这条正是专家组评估里「隐藏 vs 删除」的隐私缺口补丁。
 */
export function readReplaceOp(e) {
  const op = e && e.surfaceOp;
  if (!op || typeof op !== "object" || op.op !== "replace") return null;
  const startSeq = Number.isSafeInteger(op.startSeq) ? op.startSeq : op.start;
  const endSeq = Number.isSafeInteger(op.endSeq) ? op.endSeq : op.end;
  if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(endSeq)) return null;
  return { startSeq, endSeq };
}

export function computeShadowed(events) {
  const shadowed = new Set();
  for (const e of events) {
    const range = readReplaceOp(e);
    if (!range) continue;
    // M1 护栏：超 span 上限直接抛（fail loud）。indexer 的 per-session catch
    // 会捕获并跳过该会话（保留旧缓存），不允许把事件循环卡死在无界循环上。
    // 与 dsh-message-ops 的**有意分歧**，见 MAX_SPAN 注释。
    if (range.endSeq - range.startSeq > MAX_SPAN) {
      throw new SessionFileError(
        `surface replace span too large: [${range.startSeq}..${range.endSeq}] exceeds MAX_SPAN=${MAX_SPAN} — refusing to materialize (corrupt or hostile replace marker?)`,
      );
    }
    for (let s = range.startSeq; s <= range.endSeq; s++) shadowed.add(s);
  }
  return shadowed;
}

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
      // 0.1.6（P2）：代际文件名泛扫——固定 v4/v3 字面量会让 v5+ 的会话文件
      // 永远发现不了（静默断索引）。先试已知 cohort，再扫 session.vN.jsonl.zstd
      // 取 N 最大者（与 lazy-view artifact.js 同款做法），legacy 兜底。
      let logPath, format, st;
      const dirPath = path.join(root, slug.name, id.name);
      const knownNames = [
        ["session.v4.jsonl.zstd", "v4-multiframe"],
        ["session.v3.jsonl.zstd", "v3-multiframe"],
      ];
      for (const [name, fmt] of knownNames) {
        const candidate = path.join(dirPath, name);
        try { st = fs.statSync(candidate); logPath = candidate; format = fmt; break; } catch { continue; }
      }
      if (!logPath) {
        try {
          let bestN = -1;
          for (const f of fs.readdirSync(dirPath)) {
            const m = /^session\.v(\d+)\.jsonl\.zstd$/.exec(f);
            if (m) {
              const n = Number.parseInt(m[1], 10);
              if (Number.isSafeInteger(n) && n > bestN) { bestN = n; logPath = path.join(dirPath, f); }
            }
          }
          if (logPath) format = `v${bestN}-multiframe`;
        } catch { /* dir gone → legacy fallback below */ }
      }
      if (!logPath) {
        const candidate = path.join(dirPath, "session.jsonl.zstd");
        try { st = fs.statSync(candidate); logPath = candidate; format = "legacy-single-frame"; } catch { /* none */ }
      }
      if (!logPath) continue;
      out.push({ slug: slug.name, id: id.name, logPath, format, mtime: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

/** 测试/复用：写一份最小会话日志（真实 zstd 格式）。format: "v4"|"v3"|"legacy"。 */
export function writeSessionLog(dir, header, events, format = "v4") {
  fs.mkdirSync(dir, { recursive: true });
  const compress = (s) => zstdCompressSync(Buffer.from(s, "utf8"), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
  const name = format === "v4" ? "session.v4.jsonl.zstd"
    : format === "v3" ? "session.v3.jsonl.zstd"
    : "session.jsonl.zstd";
  const buf = format === "legacy"
    ? compress([JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join("\n") + "\n")
    : Buffer.concat([
        compress(JSON.stringify(header) + "\n"),
        compress(events.map((e) => JSON.stringify(e)).join("\n") + "\n"),
      ]);
  const logPath = path.join(dir, name);
  fs.writeFileSync(logPath, buf);
  const st = fs.statSync(logPath);
  return { logPath, format, mtime: st.mtimeMs, size: st.size };
}
