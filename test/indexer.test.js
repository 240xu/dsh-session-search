/**
 * dsh-session-search — 零依赖测试（node --test）。
 * 覆盖：索引构建与增量跳过（mtime 不变）、缓存原子写、
 * 搜索命中/排序/limit/project 过滤、信任围栏 403/415、工具容错注册。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ss-'))

const { SessionIndex } = await import('../src/indexer.js')
const { writeSessionLog, cacheRoot, readSessionFile, discoverSessionLogs } = await import('../src/session-file.js')
const { isTrustedApiRequest, } = await import('../src/fence.js')
const { apply } = await import('../src/index.js')

let n = 0
function makeSession(slug, text, extraEvents = []) {
  n++
  const id = `session-12345678-1234-1234-1234-${String(10000000 + n).padStart(12, '0')}`
  const events = [
    { type: 'user/message', seq: 0, surfaceOp: 'append', data: { message: { role: 'user', content: [{ type: 'text', text }] } } },
    { type: 'assistant/message', seq: 1, surfaceOp: 'append', data: { message: { role: 'assistant', content: [{ type: 'text', text: '回复：' + text }] } } },
    ...extraEvents,
  ]
  const { logPath, mtime, size } = writeSessionLog(
    path.join(process.env.DSH_HOME, 'sessions', slug, id),
    { type: 'session', version: 3, id, createdAt: Date.now(), title: slug + ' 标题' },
    events,
  )
  return { slug, id, logPath, mtime, size }
}

test('索引：全量构建命中消息（截 500 字符），tool/call 与空文本不入索引', async () => {
  makeSession('proj-a', '讨论增量索引的设计')
  makeSession('proj-a', '无关内容', [
    { type: 'tool/call', seq: 2, data: { name: 'bash', call: { arguments: { command: '讨论增量索引的 shell' } } } },
    { type: 'user/message', seq: 3, surfaceOp: 'append', data: { message: { role: 'user', content: [{ type: 'text', text: '  ' }] } } },
  ])
  const index = new SessionIndex()
  const stats = await index.refresh()
  assert.equal(stats.scanned, 2)
  assert.equal(stats.total, 2)
  const hits = index.search('增量索引')
  assert.ok(hits.length >= 2)
  for (const h of hits) {
    assert.ok(h.type !== 'tool/call')
    assert.ok(h.snippet.includes('增量索引'))
  }
})

test('增量：mtime+size 未变则跳过重扫（refresh 返回 skipped）', async () => {
  const s = makeSession('proj-b', '第二次构建的会话')
  const first = new SessionIndex()
  await first.refresh()
  const entry = first.cache.sessions[`${s.slug}/${s.id}`]
  assert.ok(entry)
  const before = entry.messages
  const stats = await first.refresh()
  assert.equal(stats.skipped, Object.keys(discoverSessionLogs()).length)
  assert.equal(stats.scanned, 0)
  assert.equal(first.cache.sessions[`${s.slug}/${s.id}`].messages, before) // 同一对象引用：未重扫
})

test('增量：日志变更后重扫该会话；删除的会话从缓存移除', async () => {
  const s = makeSession('proj-c', '变更前的文本')
  const idx = new SessionIndex()
  await idx.refresh()
  // 变更：重写日志（mtime/size 变化）
  writeSessionLog(
    path.join(process.env.DSH_HOME, 'sessions', s.slug, s.id),
    { type: 'session', version: 3, id: s.id, createdAt: 1 },
    [{ type: 'user/message', seq: 0, surfaceOp: 'append', data: { message: { role: 'user', content: [{ type: 'text', text: '变更后的独有词 quuxzz' }] } } }],
  )
  const stats = await idx.refresh()
  assert.equal(stats.scanned, 1) // 只有被重写的会话重扫
  assert.ok(idx.search('quuxzz').length === 1)
  assert.ok(idx.search('变更前的文本').length === 0)
  // 删除
  fs.rmSync(path.join(process.env.DSH_HOME, 'sessions', s.slug, s.id), { recursive: true, force: true })
  const remaining = Object.keys(discoverSessionLogs()).length
  const stats2 = await idx.refresh()
  assert.equal(stats2.removed, 1)
  assert.equal(Object.keys(idx.cache.sessions).length, remaining)
})

test('缓存持久化：原子写 index.json，重建实例直接吃缓存', async () => {
  makeSession('proj-d', '缓存持久化验证文本')
  const a = new SessionIndex()
  await a.refresh()
  assert.ok(fs.existsSync(path.join(cacheRoot(), 'index.json')))
  const b = new SessionIndex()
  const stats = await b.refresh()
  assert.equal(stats.skipped, Object.keys(discoverSessionLogs()).length) // 全部跳过
  assert.ok(b.search('缓存持久化验证文本').length >= 1)
})

test('搜索：mtime 新→旧排序、limit 截断、project 过滤、空查询返回 []', async () => {
  makeSession('proj-e', '排序测试 共同词 alpha')
  makeSession('proj-f', '排序测试 共同词 alpha')
  const index = new SessionIndex()
  await index.refresh()
  const hits = index.search('alpha')
  assert.ok(hits.length >= 2)
  const mtimes = hits.map((h) => {
    const s = Object.values(index.cache.sessions).find((x) => x.id === h.session.id)
    return s.mtime
  })
  assert.deepEqual(mtimes, [...mtimes].sort((a, b) => b - a))
  assert.equal(index.search('alpha', { limit: 1 }).length, 1)
  const pf = index.search('alpha', { project: 'proj-f' })
  assert.ok(pf.length >= 1 && pf.every((h) => h.session.slug === 'proj-f'))
  assert.deepEqual(index.search('   '), [])
  // limit 上界钳制到 100
  assert.equal(index.search('alpha', { limit: 1e9 }).length <= 100, true)
})

test('搜索：snippet 为 ±60 窗口带省略号（长文本）', async () => {
  const long = '前缀'.repeat(80) + ' needle-here ' + '后缀'.repeat(80)
  makeSession('proj-g', long)
  const index = new SessionIndex()
  await index.refresh()
  const [hit] = index.search('needle-here')
  assert.ok(hit)
  assert.ok(hit.snippet.startsWith('…') && hit.snippet.endsWith('…'))
  assert.ok(hit.snippet.includes('needle-here'))
  assert.ok(hit.snippet.length < 200)
})

// --- 信任围栏（上线硬门槛） ----------------------------------------------------

test('围栏纯函数：非回环 Host 拒绝；cross-site 拒绝；同源 Origin 放行', () => {
  assert.equal(isTrustedApiRequest({ headers: { host: 'evil.com' } }), false)
  assert.equal(isTrustedApiRequest({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(isTrustedApiRequest({ headers: { host: '127.0.0.1:3080', origin: 'http://evil.com' } }), false)
  assert.equal(isTrustedApiRequest({ headers: { host: 'localhost:3080', origin: 'http://localhost:3080' } }), true)
  assert.equal(isTrustedApiRequest({ headers: {} }), false)
})

function makeCtx() {
  const routes = new Map()
  const ctx = {
    get(k) { return k === 'webServer' ? { register: (r) => routes.set(r.path, r.handler) } : undefined },
    inject() {},
    effect(fn) { return fn() },
  }
  apply(ctx)
  return routes
}

function mockReq({ method = 'GET', url = '/', headers = {} } = {}) {
  return { method, url, headers, async *[Symbol.asyncIterator]() {} }
}

function mockRes() {
  const out = { status: null, headers: null, body: '' }
  out.writeHead = (status, headers) => { out.status = status; out.headers = headers || {} }
  out.end = (b) => { out.body = b == null ? '' : String(b) }
  return out
}

test('路由级：搜索/面板/refresh 非回环 Host 全部 403（围栏先于一切业务）', async () => {
  const routes = makeCtx()
  const evil = { host: 'evil.com:3080' }
  for (const [route, method] of [['/api/session-search?q=x', 'GET'], ['/api/session-search/panel', 'GET'], ['/api/session-search/refresh', 'POST']]) {
    const res = mockRes()
    await routes.get(route.split('?')[0])(mockReq({ method, url: route, headers: evil }), res)
    assert.equal(res.status, 403, route)
  }
})

test('路由级：refresh 写方法 text/plain → 415；回环同源搜索 → 200', async () => {
  const routes = makeCtx()
  const res1 = mockRes()
  await routes.get('/api/session-search/refresh')(mockReq({
    method: 'POST', url: '/api/session-search/refresh',
    headers: { host: '127.0.0.1', 'content-type': 'text/plain' },
  }), res1)
  assert.equal(res1.status, 415)

  makeSession('proj-h', '路由搜索命中词 httpword')
  const res2 = mockRes()
  await routes.get('/api/session-search')(mockReq({
    url: '/api/session-search?q=' + encodeURIComponent('httpword'),
    headers: { host: 'localhost:3080', origin: 'http://localhost:3080' },
  }), res2)
  assert.equal(res2.status, 200)
  const body = JSON.parse(res2.body)
  assert.equal(body.ok, true)
  assert.ok(body.results.length >= 1)
})

test('面板页：200 + text/html，无 X-Frame-Options 强设，插值全部 esc（无原始 <script 注入面）', async () => {
  const routes = makeCtx()
  const res = mockRes()
  await routes.get('/api/session-search/panel')(mockReq({
    url: '/api/session-search/panel', headers: { host: 'localhost' },
  }), res)
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /text\/html/)
  assert.match(res.body, /<div id="results">/)
  // 面板自身不含任何未转义服务端插值（页面是静态字符串，动态插值全走 DOM textContent/esc）
  assert.ok(!res.body.includes('__INDEX__'))
})

// --- 工具容错注册 ----------------------------------------------------------------

test('apply：无 webServer、无 tools 时走 inject 等待，不抛错；dsh-tools 缺失静默跳过', () => {
  const injects = []
  const ctx = {
    get() { return undefined },
    inject(deps, fn) { injects.push(deps) },
    effect(fn) { return fn() },
  }
  assert.doesNotThrow(() => apply(ctx))
  assert.ok(injects.some((d) => d[0] === 'webServer'))
  assert.ok(injects.some((d) => d[0] === 'tools'))
  const ctx2 = {
    get(k) { return k === 'webServer' ? { register: () => {} } : k === 'tools' ? { register: () => {} } : undefined },
    inject() {},
    effect(fn) { return fn() },
  }
  assert.doesNotThrow(() => apply(ctx2)) // tools 在但包不可解析 → 静默跳过，不产生未处理拒绝
})

test('readSessionFile 往返：真实 zstd 格式可读（自包含实现健全）', () => {
  const s = makeSession('proj-i', '自包含读取验证')
  const { header, events } = readSessionFile(s.logPath)
  assert.equal(header.type, 'session')
  assert.equal(events.length, 2)
})

// ── 0.1.5 回归（P1 毒化）：同步抛出不得永久毒化 refresh；坏缓存必须自愈 ────
// 毒化窗口 = IIFE 首个 await 之前的同步抛出：内层 finally 的 scanning=null 先于
// 赋值执行，随后 rejected promise 被挂上。构造向量：缓存已热（全部 cache-hit，
// 循环不 await）+ 有删除（removed>0 → 必 saveCache）+ 缓存目录被同名文件占位
// （mkdirSync 同步抛 ENOTDIR/EEXIST）→ 精确命中同步窗口。
test('毒化回归：同步窗口抛出后，下一次 refresh 必须仍可执行', async () => {
  const s1 = makeSession('proj-poison', '毒化恢复用查询内容')
  const idx = new SessionIndex()
  const warm = await idx.refresh()
  assert.ok(warm.total >= 1, '缓存预热')
  // 制造 removed>0：删掉一个会话目录
  fs.rmSync(path.join(process.env.DSH_HOME, 'sessions', s1.slug, s1.id), { recursive: true, force: true })
  // 缓存目录换成同名文件 → saveCache 的 mkdirSync 同步抛
  const cr = cacheRoot()
  fs.rmSync(cr, { recursive: true, force: true })
  fs.writeFileSync(cr, 'not a directory')
  let firstRejected = false
  try { await idx.refresh() } catch { firstRejected = true }
  assert.equal(firstRejected, true, '同步窗口的 saveCache 抛出必须以 rejection 呈现')
  // 修复故障：恢复缓存目录
  fs.unlinkSync(cr)
  // 关键断言：修复后 refresh 必须成功（原 bug：永久返回同一个 rejected promise）
  const second = await idx.refresh()
  assert.ok(second && typeof second.total === 'number', '修复后 refresh 必须恢复，而非继续返回被毒化的 rejected promise')
})

test('毒化回归：sessions:null 的坏缓存走重建而非 TypeError', async () => {
  const dir = cacheRoot()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ version: 1, builtAt: 1, sessions: null }))
  const idx = new SessionIndex()
  const res = await idx.refresh()
  assert.ok(res && typeof res.total === 'number', '坏缓存被识别并重建，不抛 TypeError（typeof null === object 陷阱）')
})
