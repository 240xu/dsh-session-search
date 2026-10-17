/**
 * dsh-session-search 0.1.7 — 被回滚遮蔽的消息不进索引。
 *
 * 对应 dsh-message-ops 专家组评估的隐私缺口 #3：
 * 「遮蔽 ≠ 搜索不可见；用户以为删了其实还能搜到」。
 *
 * 三条语义 + 防漂移锁：
 *   1. revert 后原 seq 在 surface replace 区间内 → 搜索**搜不到**；
 *   2. restore 以新 seq 追加重放副本（不在任何 replace 区间）→ **仍能搜到**，
 *      且死本已被滤掉 → 不会同一段话出现两条；
 *   3. 缓存 version 1→2：旧缓存存的是未过滤条目，必须被拒并全量重建；
 *   4. 防漂移锁：本插件「自包含复制」的 computeShadowed / scanZstdFrames
 *      （session-file.js）与 isTrustedApiRequest（fence.js）必须与
 *      dsh-message-ops 的同族实现对**同一批输入**产出**完全相同**的结果。
 *      复制方案的真实风险是悄悄走样 → 这些锁就是它的看门狗；
 *      两条实现一旦分叉，本测试立刻红，而不是让用户去搜到已回滚的内容。
 *      注：computeShadowed 的 MAX_SPAN 护栏是本插件的有意扩展（M1），
 *      源实现没有它；锁的等值域是双方共同域（span ≤ MAX_SPAN）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ss-shadow-'))

// M4（0.1.7）：基线路径不再硬编码绝对路径 —— 本仓库与 dsh-message-ops 约定
// 同级并列（../dsh-plugins-src/*）；按相对本仓库定位，但等值断言依旧要求
// message-ops 源码在场：找不到就 console.warn 一次并 skip 相关用例
// （skip-loud，不是静默吞 —— 缺基线≠等值，绝不能假装绿）。
const HERE = path.dirname(fileURLToPath(import.meta.url))
const M = path.join(HERE, '../../dsh-message-ops/src/session-file.js')
const M_OPS = path.join(HERE, '../../dsh-message-ops/src/ops-core.js')
const MISSING = [M, M_OPS].filter((p) => !fs.existsSync(p))
if (MISSING.length > 0) {
  console.warn(
    `[dsh-session-search test] 防漂移锁基线缺失（skip-loud）：测试文件旁找不到 ${MISSING.join(', ')}` +
    ` —— dsh-message-ops 不在本仓库旁，相关等值锁用例将 skip；等值未能验证 ≠ 等值`,
  )
}

const { SessionIndex } = await import('../src/indexer.js')
const { writeSessionLog, computeShadowed, scanZstdFrames } = await import('../src/session-file.js')
const { isTrustedApiRequest } = await import('../src/fence.js')

let n = 0
function user(seq, text) {
  return { type: 'user/message', seq, surfaceOp: 'append', data: { message: { role: 'user', content: [{ type: 'text', text }] } } }
}
function assistant(seq, text) {
  return { type: 'assistant/message', seq, surfaceOp: 'append', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}
/** 回滚 marker：append-only 的 surface replace，遮蔽 [start..end]。 */
function revertMarker(seq, start, end) {
  return { type: 'system/message', seq, surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, data: { message: { role: 'system', content: [{ type: 'text', text: `reverted ${end - start + 1} messages` }] } } }
}
function makeSession(slug, title, events) {
  n++
  const id = `session-aaaa0000-1111-2222-3333-${String(10000000 + n).padStart(12, '0')}`
  const { logPath } = writeSessionLog(
    path.join(process.env.DSH_HOME, 'sessions', slug, id),
    { type: 'session', version: 3, id, createdAt: Date.now(), title },
    events,
  )
  return { slug, id, logPath }
}

test('revert 后：被遮蔽的原 seq 搜不到', async () => {
  makeSession('p-shadow', '已回滚未恢复', [
    user(0, '机密话题：部署密钥是 ALPHA-7788'),
    assistant(1, '收到，密钥 ALPHA-7788 我记下了'),
    revertMarker(2, 0, 1),
  ])
  const index = new SessionIndex()
  await index.refresh()
  const hits = index.search('ALPHA-7788')
  assert.equal(hits.length, 0, `已回滚内容不应可搜，实际 ${hits.length} 条：${JSON.stringify(hits).slice(0, 300)}`)
})

test('restore 后：重放副本（新 seq，不在 replace 区间）仍可搜，且死本不重复', async () => {
  makeSession('p-restored', '已回滚并恢复', [
    user(0, '机密话题：部署密钥是 ALPHA-7788'),
    assistant(1, '收到，密钥 ALPHA-7788 我记下了'),
    revertMarker(2, 0, 1),
    // restore 的 append 语义：副本带**新 seq** 落到日志尾，不在 [0..1] 内
    user(3, '机密话题：部署密钥是 ALPHA-7788'),
  ])
  const index = new SessionIndex()
  await index.refresh()
  const hits = index.search('ALPHA-7788')
  assert.equal(hits.length, 1, `应只命中恢复后的 1 条副本，实际 ${hits.length} 条`)
  assert.equal(hits[0].seq, 3, `应命中重放副本 seq 3，实际 seq ${hits[0].seq}`)
})

test('无 marker 的会话不受影响（基线不回归）', async () => {
  // 用独立检索词：search 是跨会话聚合，前两个用例的会话仍在同一 DSH_HOME 缓存里
  makeSession('p-plain', '普通会话', [
    user(0, '请帮我跑一下测试 BASELINE-QUX'),
    assistant(1, '测试跑完了 BASELINE-QUX'),
  ])
  const index = new SessionIndex()
  await index.refresh()
  const hits = index.search('BASELINE-QUX')
  assert.equal(hits.length, 2, `普通会话两条都应命中，实际 ${hits.length} 条`)
})

test('缓存 version 门：v1/v2（未过滤遮蔽 / 反向忽略时代）缓存被拒并全量重建', async () => {
  // 构造一个 version:1 的陈旧缓存 —— 它代表「过滤前」的索引状态
  const cacheFile = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    '../src/indexer.js', // 仅为占位，真正路径走 cacheRoot()
  )
  void cacheFile
  const { cacheRoot } = await import('../src/session-file.js')
  fs.mkdirSync(cacheRoot(), { recursive: true })
  fs.writeFileSync(path.join(cacheRoot(), 'index.json'), JSON.stringify({
    version: 2, builtAt: Date.now(),
    sessions: { 'ghost/session': { title: '回滚前的陈旧索引', mtimeMs: 1, size: 1, messages: [{ seq: 0, type: 'user/message', text: 'ALPHA-7788 旧缓存里的机密' }] } },
  }))
  const index = new SessionIndex()
  assert.equal(index.cache.version, 3, 'v1/v2 缓存必须被拒，落到 version 3 空缓存')
  assert.equal(Object.keys(index.cache.sessions).length, 0, 'v1/v2 条目不得被继承')
})

test('防漂移锁：本插件 computeShadowed 与 dsh-message-ops 实现逐事件等值', {
  skip: MISSING.includes(M) ? 'message-ops 基线缺失（见顶部 console.warn），等值未能验证' : false,
}, async () => {
  const ref = await import(M)
  assert.equal(typeof ref.computeShadowed, 'function', 'message-ops 必须导出 computeShadowed')

  const cases = [
    [],
    [{ type: 'system/message', seq: 0 }],
    [{ type: 'system/message', seq: 0, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 3 } }],
    [{ type: 'system/message', seq: 0, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 } }],
    // 起止一致
    [{ type: 'system/message', seq: 0, surfaceOp: { op: 'replace', start: 5, end: 9 } }],
    // 非法/畸形：不得抛错，两边都应忽略
    [{ type: 'system/message', seq: 0, surfaceOp: 'append' }],
    [{ type: 'system/message', seq: 0, surfaceOp: { op: 'append', startSeq: 1, endSeq: 9 } }],
    [{ type: 'system/message', seq: 0, surfaceOp: { op: 'replace', startSeq: 'x', endSeq: 9 } }],
    // M2′正例：反向区间 [9>4] = 引擎「索引序重算」的真遮蔽（复演实证，非畸形）——
    // 无 sourceEventSeqs 凭据 → 两实现都按旧约定忽略（等值域内的保守行为），但
    // 语义注释已翻转：这不再是「非法」，而是「无凭据时无法等价推导 → 忽略」。
    [{ type: 'system/message', seq: 10, surfaceOp: { op: 'replace', startSeq: 9, endSeq: 4 } }],
    // M2′正例：反向区间 + 凭据 → 按凭据折叠（引擎等价，语料 afcc0453 形态）
    [
      {
        type: 'user/message', seq: 718,
        sourceEventSeqs: [530, 531, 465],
        surfaceOp: { op: 'replace', startSeq: 530, endSeq: 465 },
        data: { message: { role: 'user', content: [{ type: 'text', text: 'compacted' }] }, source: { kind: 'compact-checkpoint' } },
      },
      { type: 'system/message', seq: 10, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 } },
    ],
    // M2′ 畸形凭据（非整数/越界 → 逐项丢弃，仍不抛）
    [
      {
        type: 'user/message', seq: 20,
        sourceEventSeqs: ['x', 21, -1, null, 19],
        surfaceOp: { op: 'replace', startSeq: 30, endSeq: 2 },
      },
    ],
    // 多 marker 叠加（含一条反向带凭据）
    [
      { type: 'system/message', seq: 0, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 2 } },
      {
        type: 'user/message', seq: 9,
        sourceEventSeqs: [7, 8],
        surfaceOp: { op: 'replace', startSeq: 8, endSeq: 7 },
      },
      { type: 'user/message', seq: 12, surfaceOp: 'append' },
    ],
    // 混入无 surfaceOp 的普通消息
    [
      { type: 'user/message', seq: 0, surfaceOp: 'append' },
      { type: 'system/message', seq: 1, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 5 } },
      null, undefined, {}, { type: 'x' },
    ],
  ]

  for (const [i, events] of cases.entries()) {
    const mine = [...computeShadowed(events)].sort((a, b) => a - b)
    const theirs = [...ref.computeShadowed(events)].sort((a, b) => a - b)
    assert.deepEqual(mine, theirs,
      `case #${i} 两实现不一致 —— 自包含副本已与 dsh-message-ops 走样，请同步修复（勿直接改断言）\n` +
      `  本插件: ${JSON.stringify(mine)}\n  源实现: ${JSON.stringify(theirs)}`)
  }
})

test('防漂移锁：本插件 scanZstdFrames 与 dsh-message-ops 帧扫描逐位等值', {
  skip: MISSING.includes(M) ? 'message-ops 基线缺失（见顶部 console.warn），等值未能验证' : false,
}, async () => {
  const ref = await import(M)
  assert.equal(typeof ref.scanZstdFrames, 'function', 'message-ops 必须导出 scanZstdFrames')

  const magic = () => Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const fill = (n) => Buffer.alloc(n, 0x78) // 'x' —— 永不含魔数，方便读期望值
  // 真实 zstd 帧（带 checksum）：压缩 payload 内可能出现假魔数 —— 两个实现
  // 看同一份字节流必须切出同样的帧边界（这正是逐位等值的意义）。
  const realFrame = (n) => zstdCompressSync(Buffer.alloc(n, 0x61))

  const cases = [
    // 边界：空 / 短于 4 字节（tornStart）
    Buffer.alloc(0),
    Buffer.alloc(1),
    Buffer.alloc(3),
    Buffer.concat([magic().subarray(0, 3)]),
    // 单帧 / 多帧完整流
    Buffer.concat([magic(), fill(8)]),
    Buffer.concat([magic(), fill(8), magic(), fill(4)]),
    Buffer.concat([magic(), fill(8), magic(), fill(2), magic(), fill(0)]),
    // 帧内含假魔数（scanner 不解压，按字节扫 —— 两实现必须同位）
    Buffer.concat([magic(), Buffer.from([0, 0x28, 0xb5, 0x2f, 0xfd, 1]), fill(4)]),
    // 撕裂尾：不满 4 字节的残帧
    Buffer.concat([magic(), fill(8), magic().subarray(0, 3)]),
    // 尾部恰好一个完整裸魔数（frame of garbage/空 payload —— 两边判定一致）
    Buffer.concat([magic(), fill(8), magic()]),
    // 真实 zstd 帧串联 + 残尾
    Buffer.concat([realFrame(30000), realFrame(7), magic(), magic(), magic().subarray(0, 2)]),
    Buffer.concat([realFrame(1), realFrame(1), realFrame(1)]),
    // 坏魔数 → 两个实现抛同样的 message
    fill(10),
    Buffer.concat([Buffer.from([1, 2, 3, 4]), magic(), fill(4)]),
  ]

  for (const [i, buf] of cases.entries()) {
    let mine, mineErr, theirs, theirsErr
    try { mine = scanZstdFrames(buf) } catch (e) { mineErr = e }
    try { theirs = ref.scanZstdFrames(buf) } catch (e) { theirsErr = e }
    assert.equal(
      mineErr ? mineErr.message : null,
      theirsErr ? theirsErr.message : null,
      `case #${i} 抛错行为不一致 —— 帧扫描副本已与 dsh-message-ops 走样（勿直接改断言）`,
    )
    assert.deepEqual(
      mine ?? null, theirs ?? null,
      `case #${i} 帧边界不一致 —— 帧扫描副本已与 dsh-message-ops 走样（勿直接改断言）\n` +
      `  本插件: ${JSON.stringify(mine ?? { err: String(mineErr) })}\n  源实现: ${JSON.stringify(theirs ?? { err: String(theirsErr) })}`,
    )
  }
})

test('防漂移锁：本插件 isTrustedApiRequest 与 dsh-message-ops/ops-core 围栏逐请求等值', {
  skip: MISSING.includes(M_OPS) ? 'message-ops 基线缺失（见顶部 console.warn），等值未能验证' : false,
}, async () => {
  const ref = await import(M_OPS)
  assert.equal(typeof ref.isTrustedApiRequest, 'function', 'ops-core 必须导出 isTrustedApiRequest')

  const reqs = [
    undefined,                                  // 无 req
    { headers: null },
    { headers: {} },                            // 无 Host
    { headers: { host: 'evil.com' } },          // 非回环
    { headers: { host: 'evil.com:3080' } },
    { headers: { host: '127.0.0.1:3080' } },
    { headers: { host: '127.0.0.1' } },
    { headers: { host: 'localhost:3080' } },
    { headers: { host: '[::1]:3080' } },
    { headers: { host: '[::1]' } },
    { headers: { host: '256.300.1.1' } },       // 非法 IPv4
    { headers: { host: '0.0.0.0' } },
    { headers: { host: 'sub.127.0.0.1' } },     // 5 段
    { headers: { host: '127.0.0.1:99999' } },   // 端口超界 → parseAuthority 失败
    { headers: { host: 127000 } },              // 非字符串 host
    { headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } },
    { headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' } },
    { headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } },
    { headers: { host: '127.0.0.1:3080', origin: 'http://evil.com' } },
    { headers: { host: '127.0.0.1:3080', origin: null } },
    { headers: { host: '127.0.0.1:3080', origin: '::not a url::' } },
    { headers: { host: 'localhost:3080', origin: ['http://localhost:3080'] } }, // 非字符串 origin
    { headers: { host: 'evil.com', origin: 'http://evil.com' } },               // Origin 兜不住非回环
  ]

  for (const [i, req] of reqs.entries()) {
    const mine = isTrustedApiRequest(req)
    const theirs = ref.isTrustedApiRequest(req)
    assert.equal(mine, theirs,
      `case #${i} 围栏判定不一致 —— fence 副本已与 dsh-message-ops/ops-core 走样（勿直接改断言）\n` +
      `  本插件: ${mine}\n  源实现: ${theirs}\n  req: ${JSON.stringify(req)}`)
  }
})

test('M1 护栏：computeShadowed 超大 span 直接抛错（不允许无界循环）', () => {
  const hostile = [{
    type: 'system/message', seq: 1,
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 2_000_000 },
  }]
  assert.throws(() => computeShadowed(hostile), /span too large/,
    '超出 MAX_SPAN 的 replace marker 必须 fail loud（护栏与 dsh-message-ops 的有意分歧，勿改护栏）')
  // 正常区间内（span ≤ MAX_SPAN 的共同域）不抛
  const plain = [{ type: 'system/message', seq: 9, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 5 } }]
  assert.deepEqual([...computeShadowed(plain)].sort(), [0, 1, 2, 3, 4, 5])
})

test('M1 护栏：坏 marker 会话在增量 refresh 中被 per-session skip，其余会话照常索引', async () => {
  makeSession('p-span-guard', '护栏外围正常会话', [
    user(0, '正常可搜 token SPAN-GOOD'),
  ])
  makeSession('p-span-bad', '含敌对超大 replace marker', [
    user(0, '坏会话 token SPAN-HOSTILE'),
    { type: 'system/message', seq: 1, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 5_000_000 } },
  ])
  const index = new SessionIndex()
  const stats = await index.refresh()
  assert.equal(index.search('SPAN-HOSTILE').length, 0, '坏 marker 会话不得进索引')
  assert.ok(index.search('SPAN-GOOD').length >= 1, '同批其它会话必须照常索引')
  assert.ok(stats.total >= 2)
})
