/**
 * dsh-session-search 0.1.7 — 被回滚遮蔽的消息不进索引。
 *
 * 对应 dsh-message-ops 专家组评估的隐私缺口 #3：
 * 「遮蔽 ≠ 搜索不可见；用户以为删了其实还能搜到」。
 *
 * 三条语义 + 一条防漂移锁：
 *   1. revert 后原 seq 在 surface replace 区间内 → 搜索**搜不到**；
 *   2. restore 以新 seq 追加重放副本（不在任何 replace 区间）→ **仍能搜到**，
 *      且死本已被滤掉 → 不会同一段话出现两条；
 *   3. 缓存 version 1→2：旧缓存存的是未过滤条目，必须被拒并全量重建；
 *   4. 防漂移锁：本插件「自包含复制」的 computeShadowed 必须与
 *      dsh-message-ops 的实现对**同一批事件**产出**完全相同**的集合。
 *      复制方案的真实风险是悄悄走样 → 这条锁就是它的看门狗；
 *      两条实现一旦分叉，本测试立刻红，而不是让用户去搜到已回滚的内容。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ss-shadow-'))

const { SessionIndex } = await import('../src/indexer.js')
const { writeSessionLog, computeShadowed } = await import('../src/session-file.js')

const M = '/data/data/com.termux/files/home/dsh-plugins-src/dsh-message-ops/src/session-file.js'

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

test('缓存 version 1→2：旧版（未过滤遮蔽）缓存被拒并全量重建', async () => {
  // 构造一个 version:1 的陈旧缓存 —— 它代表「过滤前」的索引状态
  const cacheFile = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    '../src/indexer.js', // 仅为占位，真正路径走 cacheRoot()
  )
  void cacheFile
  const { cacheRoot } = await import('../src/session-file.js')
  fs.mkdirSync(cacheRoot(), { recursive: true })
  fs.writeFileSync(path.join(cacheRoot(), 'index.json'), JSON.stringify({
    version: 1, builtAt: Date.now(),
    sessions: { 'ghost/session': { title: '回滚前的陈旧索引', mtimeMs: 1, size: 1, messages: [{ seq: 0, type: 'user/message', text: 'ALPHA-7788 旧缓存里的机密' }] } },
  }))
  const index = new SessionIndex()
  assert.equal(index.cache.version, 2, 'v1 缓存必须被拒，落到 version 2 空缓存')
  assert.equal(Object.keys(index.cache.sessions).length, 0, 'v1 条目不得被继承')
})

test('防漂移锁：本插件 computeShadowed 与 dsh-message-ops 实现逐事件等值', async () => {
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
    [{ type: 'system/message', seq: 0, surfaceOp: { op: 'replace', startSeq: 9, endSeq: 4 } }],
    // 多 marker 叠加
    [
      { type: 'system/message', seq: 0, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 2 } },
      { type: 'system/message', seq: 9, surfaceOp: { op: 'replace', startSeq: 7, endSeq: 11 } },
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
