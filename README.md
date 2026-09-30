# @240xu/dsh-session-search
<!-- TODO(截图): 真机截图替换占位图（本轮无浏览器通道，不硬造） -->

DSH web 插件：**跨会话全文搜索**。对 `~/.dsh/sessions` 下全部会话日志（多帧
zstd，v3 格式）建立消息级全文索引，一条关键词查回所有历史会话的命中位置
（sessionId + seq ±60 字符窗口摘录）。

- **零 npm 依赖**（node:zlib zstd + 纯 JS）；
- **对 `~/.dsh/sessions` 零写入**：索引缓存是唯一写点，存
  `$DSH_HOME/cache/session-search/index.json`（原子写 tmp+rename）；
- **侧边栏零触碰**：无任何 sidebar 注册面，UI 是独立面板页
  `/api/session-search/panel`（devkit 装了可由 Ctrl+K 命令指向该 URL）；
- **信任围栏硬门槛**：全部路由先过 `isTrustedApiRequest`（回环 Host 挡
  DNS rebinding + `sec-fetch-site: cross-site` 拒绝 + Origin 同源校验），
  与 dsh-message-ops 0.2.1 同款（arch-review L4/L5 教训）。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/api/session-search?q=&limit=20&project=<slug 可选>` | 跨会话搜索；大小写不敏感子串（indexOf，防 ReDoS）；命中按会话 mtime 新→旧 |
| GET  | `/api/session-search/panel` | 独立 HTML 面板页（搜索框 + 结果列表 + 「复制定位」） |
| POST | `/api/session-search/refresh` | 手动触发增量刷新（Content-Type 必须 application/json） |

## Agent 工具

`session_search`（peer `@deepseek-ai/dsh-tools`，容错注册——tools 服务缺失或
包不可解析时只跳过工具，HTTP 面不受影响）：参数 `q`（必填）、`limit`（1-100）、
`project`（slug 过滤）。输出每行 `[slug] title/id seq N (type): snippet`，定位符
在前、摘录在后（见「权威依据」节）。

## 安装

```sh
# 方式一：独立安装
claude mcp add ... # 不适用；DSH 插件安装：
dsh plugin add @240xu/dsh-session-search

# 方式二：随 suite 聚合安装（@240xu/dsh-suite 依赖聚合，推荐）
dsh plugin add @240xu/dsh-suite   # 会带入本插件
```

独立安装与 suite 安装互斥即可（同 id 的 bundle 行不重复插入）。

## 索引与性能取舍

- 索引条目 = 每条 user/assistant/system message 的 `{seq, type, text(截 500 字符)}`；
  tool/call 与空文本不入索引（工具调用文本噪声大且无对话语义）。
- 增量判定：会话日志 `mtimeMs + size` 与缓存一致 → 跳过；变更/新增重扫该会话；
  消失的会话从缓存移除。
- 检索：大小写不敏感 `indexOf` 线性扫描内存数组（按 mtime 新→旧的会话序遍历，
  满 limit 即停）。本地规模（数千会话 × 数百条消息）亚秒级，未做倒排/分词。
- 首次全量构建：逐帧解压每 8 帧 `setImmediate` 让出事件循环（大会话不冻结 GUI）。

## 权威依据与取舍（读了什么 → 采纳/拒绝）

1. **node:sqlite vs JSON 索引** — Node 22.5+ 内建 `node:sqlite`（`DatabaseSync`，
   [Node v26 SQLite 文档](https://nodejs.org/api/sqlite.html)）。**拒绝迁移**：
   本插件索引是单进程、单对象（≤几 MB）的轻量投影，tmp+rename 原子写已满足
   一致性；而检索核心是 CJK **子串**匹配，SQLite FTS 默认分词器不处理 CJK 子串
   （trigram tokenizer 需要额外配置且索引体积 ×3），换 schema 反而偏离「零依赖、
   可整包删缓存」的目标。**采纳路径**：若未来语料涨到十万级消息或需要相关性
   排序，再迁 `node:sqlite`（FTS5 + trigram），接口 `SessionIndex.search()` 不变。
2. **worker_threads** — [Node Worker threads 文档](https://nodejs.org/api/worker_threads.html)
   建议 CPU 密集 JS 出主线程。**暂缓**：索引构建的耗时大头是 zstd 同步解压 +
   JSON.parse，已用帧间 `setImmediate` 让出（每 8 帧一次）把 GUI 卡顿压到帧级；
   worker 化的收益（彻底零阻塞）要付出每会话一次结构化克隆的序列化成本与
   worker 生命周期管理，在「首次构建 < 数秒」的本地规模下不成比例。**采纳阈值**：
   真实语料首次全量构建 > 5s 时再出 worker（`readSessionFileAsync` 的让出粒度
   参数已预留调优空间）。
3. **snippet 策略** — [Tavily Search Best Practices](https://docs.tavily.com/documentation/best-practices/best-practices-search)：
   面向查询的短片段（chunks）优于整页摘要；`max_results` 过高反而稀释质量
   （→ 本插件 limit 钳制 1-100、默认 20）。**采纳**：±60 字符窗口 + 首尾 `…` 的
   query-aligned 摘录。[Anthropic long-context prompting](https://www.anthropic.com/research/prompting-long-context) /
   [Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval)：
   相关内容置于上下文前部、给出来源引用。**采纳**：工具输出与面板条目都是
   「定位符（slug/session id/seq）在前、摘录在后」，让模型/用户先拿到 citation
   再读内容；agent 多轮检索的 dedupe 思路（Tavily `[...]` 分隔符合并唯一内容）
   留作工具输出的后续优化。

## 已知重复（待 suite 聚合层收口）

与生态其它插件存在有意复制（保持插件自包含、不跨包 import），待
`@240xu/dsh-suite` 聚合层提供共享工具后收口（agg-researcher L3 建议）：

- `src/fence.js` 的 `isTrustedApiRequest` ≡ dsh-message-ops `ops-core.js` 同款
  （arch-review 要求的上线硬门槛，复制是安全侧的选择）；
- `src/session-file.js` 的多帧 zstd 帧扫描/读取 ≡ dsh-message-ops `session-file.js`、
  dsh-session-lazy-view `frames.js`（同源实现，帧魔数扫描的取舍三处一致）；
- `messageText`（message 事件 → 首个非空 text 块）与 dsh-message-ops 重复。

## 开发

```sh
npm test            # 12 个零依赖测试（node --test，含围栏 403/415 与增量跳过）
node --check src/*.js
```

## License

MIT

## v0.1.4

- 命中项新增「在 Timeline 打开」按钮：直达 lazy-view 时间线深链
  `/lazyview?session=<id>&seq=<seq>`（lazy-view ≥0.3.0）。
- 主搜索按钮触控目标提升至 ≥44×44px（.acts 辅助钮 36px 下限）。
- 搜索请求飞行中按钮 disabled（含失败恢复），防重复点击。
