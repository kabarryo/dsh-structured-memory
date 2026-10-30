# dsh-structured-memory vs claude-mem：同题不同解的两种跨会话记忆

> 对比时间：2026-10-23　｜　对象：本目录 `dsh-structured-memory` v2.19.5 vs [`thedotmack/claude-mem`](https://github.com/thedotmack/claude-mem) v15.0.1
> 证据来源：本仓库源码 + claude-mem 仓库 `main` 分支源码与官方文档（均为当日读取）。官方自述的性能数字已标注「未复现」。

## 结论

**两者不是同一类东西，重叠在"跨会话记忆"，分歧在"记忆由谁产生、以什么形状存在、什么时候回到上下文"。**

- **claude-mem 是观察流水线**：被动捕获会话里发生的一切 → 用模型压成带类型的 observation → 混合检索（FTS5 + 向量）分层取回。卖点是**零人工介入**。
- **dsh-structured-memory 是结构化沉淀库**：模型在"事件确实发生"时显式写入 → 落成可读 JSON → 按层注入（画像 + 全局索引）+ 全文检索。卖点是**可控、可编辑、可预算**。

值得先纠正一个过时前提：**claude-mem 自 v13.34.0 起已有第一方 DSH 集成**（`@claude-mem/dsh`，Apache-2.0，基于 `Bleed00/dsh-claude-mem` 改写），当前版本 15.0.1。安装方式就是 DSH 自己的插件安装：

```sh
npx claude-mem install --ide dsh --dsh-profile web
```

所以这不是"原生 Claude Code 插件 vs DSH 插件"，而是**两个 DSH 插件之争**——区别在于 claude-mem 的 DSH 插件只是一个**客户端**，记忆引擎是常驻的独立 worker（Bun + SQLite + Chroma）。

## 一、事实对照

| 维度 | dsh-structured-memory 2.19.5 | claude-mem 15.0.1 |
|---|---|---|
| 定位 | DSH 专用，两级记忆 + 画像 | 跨 harness 通用记忆引擎，DSH 只是其中一个 adapter |
| 代码形态 | 纯 ESM JS，4 文件 / 274 KB，**无构建步骤** | TypeScript monorepo，`src/` 532 文件 / 5.76 MB，需 `npm run build` |
| 依赖 | **零外部依赖**（`node:sqlite` 可选，缺失自动降级） | Node 20 + **Bun** + **uv/Python** + SQLite + **Chroma** |
| 常驻进程 | 无，跑在 DSH 进程内 | 有：worker HTTP 服务（默认 37777）+ 独立 web viewer |
| 存储 | `profile.json` / `global.json` / `sessions/*.json` 为**唯一事实源**，`memory.db` 是可重建的派生 FTS5 | `~/.claude-mem/memory.db`（SQLite，observations/sessions/summaries）+ `chroma/` 向量库；全局单库，按 `project` 名过滤 |
| 写入者 | **模型显式调用** `save_memory`：`trigger` 封闭枚举 + `evidence` 证据锚 + 写入幂等 | **worker 自动捕获**（DSH 侧走 transcript watcher，读 `~/.dsh/sessions`），模型压缩成 observation |
| 记忆单元 | **每会话恰好 1 条**（改写而非追加）+ 画像 5 段 + 全局索引每会话 1 条 | 每次工具调用 / 每轮若干条 observation，带 `type` / `filesRead` / `filesModified` / `facts` / `concepts` |
| 注入时机 | **每一步渲染，变化才注入**（DSH `RuntimeContextProjection` 去重） | `agent/created` **注入一次**，之后全靠工具按需取 |
| 工具面 | 4 个：`save_memory` / `recall_memory` / `load_session_memory` / `forget_memory` | 5 个：`mem_search` / `mem_timeline` / `mem_get_observations` / `mem_save` / `mem_context`，另注册 `mem-search` skill |
| 检索 | FTS5 scope 查询（profile/global/session/all）+ 整会话加载 | FTS5 + 向量混合，三层渐进披露（search → timeline → get） |
| 人工编辑 | 插件页 6 页签（画像/索引/会话/整理/注入控制）+ `/dream`，JSON 可直接手改 | web viewer（浏览、设置、排除标记），SQLite 不面向手改 |
| 压缩 | **手动** `/dream` 或「整理该会话」，三条硬闸（必须变短、锚点不得丢、建议稿一次性） | **自动**，worker 在 `turn/end` 每轮 summarize 一次（持续消耗模型 token） |
| 隐私 | 全本地，无账户 | 默认本地；可选 hosted observer（CMEM Pro，30 天试用后回落到自家 plan）、云同步 cmem.ai、TeamBrain，另有 `<private>` 标签与自动脱敏 |
| 导出 | 带校验和的 bundle + 回滚 + fork 血缘 | 有 export/import + 云同步（未逐个比对格式） |
| 子 agent | **只读**（禁 save/forget，保留 recall/load） | 未见只读策略（`tools.ts` 无子 agent 判定） |
| 测试 | 12 套 / 约 289 断言**已于 2026-10-21 随 `/tmp` 清理丢失**，现仅 `tests/README.md` + 空占位 | `tests/` + `evals/` 共 **1,020 文件 / 8.4 MB** |
| 社区与节奏 | 自用为主，MIT，已开源（kabarryo/dsh-structured-memory） | 102k stars / 9,030 forks / 近 7 天 ≥100 commits / Apache-2.0 |

## 二、五个关键分歧

### 1. 谁决定"记什么"：门控 vs 全捕获

dsh-structured-memory 把"值不值得记"改造成"事件是否发生"（`trigger` 四值枚举），再要求 `acceptance`/`decision`/`correction` 必须给证据锚，最后用归一化比对做幂等。三道闸的设计动机写在 README 里：插件只能观测到工具调用，拦不住"模型在思考阶段自认为值得记"。

claude-mem 反过来：不判断价值，**全部捕获**，价值判断后移到压缩阶段和检索阶段。

代价差异是直接的——claude-mem 自己的 `dedupe.ts` 注释承认"worker 会把同一条 observation 反复写入（例如每轮重复的样板记录），这些近似行会淹没搜索输出并烧 token"，于是**在读取端做内容指纹折叠来补救**。dsh-structured-memory 是在写入端不出垃圾，claude-mem 是在读出端过滤垃圾。前者省存储与 token，后者不漏信息但需要后处理。

### 2. 记忆的形状：一条/会话 vs 观察流

- dsh-structured-memory：`sessions/<id>.json` 只有一条，保存即改写（`mergedCount` 记录吸收了几段），单条上限 16,000 字符，超限拒绝写入。好处是"一条 = 一个会话的当前事实"，读起来像结论而不像日志；坏处是随会话变长会变杂，所以配了「整理该会话」。
- claude-mem：一条 observation 是一个片段，带 `title/subtitle/narrative/facts/concepts/filesRead/filesModified`。好处是**可结构化检索**（"这个文件以前被谁改过"、"上次那个 bugfix 怎么修的"）；坏处是同一会话可能几十上百条，必须靠 timeline 和 ID 引用去拼故事。

这不是优劣，是**事实表 vs 事件表**的选择。dsh-structured-memory 缺的正是事件表的查询能力（见第四节）。

### 3. 什么时候回到上下文：每步变化注入 vs 会话启动一次

dsh-structured-memory 的 v2.3 改造把注入从"每步追加"改成"运行时上下文 + 变化检测"：实测 92 步会话注入从 92 次降到 1 次，累积 62,062 tokens 的浪费消失；同时因为每步重新渲染，**别的会话改了 `global.json`，本会话下一步就能看到**。

claude-mem 的 DSH 插件在 `agent/created` 调一次 `agent.inject()`，之后只靠 `mem_*` 工具按需取。好处是注入成本固定且更小；代价是**会话中途不会有新记忆浮上来**——跨会话的即时可见性在它这里是缺的（`mem_context` 要模型主动想起才会调）。

### 4. 检索：scope 查询 vs 三层渐进披露

claude-mem 的三层（search 给 50–100 token/条的索引 → timeline 看上下文 → get_observations 取 500–1,000 token/条的全文）是它最值得学的地方：**先过滤再展开**，官方称约 10x token 节省（未复现）。

dsh-structured-memory 是"索引已在上下文里（全量条目 + 最近 N 条要点），要细节就 `recall_memory(query)`，要整会话就 `load_session_memory`（可能上万 token，注入文案里明确警告了这个成本差）"。它省掉了一次检索往返，但**没有"围绕某条记忆往前看几步"的能力**。

### 5. 数据主权：JSON 文件 vs SQLite + 向量

dsh-structured-memory 的赌注是"记忆应该是人可读、可 git、可手改的文件"；claude-mem 的赌注是"记忆应该是可索引、可同步、可多端共享的库"。后者换来云同步、TeamBrain、跨 harness 统一，前者换来"出问题能直接看文件"。

对自建 harness 的人来说这不是抽象取舍：本机记忆库现状是 **18 个有记忆的会话 / 18 条记忆 / 26 条画像要点 / 76 KB**，`jq` 一行就能查完；claude-mem 对应的是几千条 observation 加一个向量库。

## 三、同为 DSH 插件，接缝不同

| | dsh-structured-memory | claude-mem（DSH） |
|---|---|---|
| `inject` | `['agents', 'tools', 'systemPrompt']` | `['tools', 'skills']` |
| 注入 API | `ctx.systemPrompt.context({ name, order: 130, text })` | `agent.inject(createUserMessage(...))` |
| 生命周期 | 每步 render（mtime+size 缓存） | `agent/created` 一次性 |
| 被动钩子 | 无 | 可选 `tools/post-execute` 观察、`agent/turn-stopping` 摘要（DSH 安装时**默认全关**） |
| 捕获路径 | 无（写入只来自模型调用） | worker 的 transcript watcher 读 `~/.dsh/sessions`，用 `transcript-schema.json` 映射事件 |
| 前端 | `client.js` 无构建客户端，注册进 DSH 插件页 | 独立 worker web viewer（另一个端口），不嵌进 DSH |
| 失败姿态 | 库不可用 → FTS 降级为 LIKE，功能不断 | worker 不可用 → 记忆工具报错；注入静默跳过（best-effort） |

一个容易忽略的事实：claude-mem 装进 DSH 时把 `ingest` 和 `summarize` 都关了（见其 `dsh/cordis.patch.yml`），因为**捕获归 worker 的 transcript watcher，保持单一写者**。也就是说它的 DSH 插件本质是"读端 + 手动存"，自动捕获发生在 DSH 进程之外的另一个常驻进程里——这在你这种 A/B 槽位自建 web 版 + 桌面版并存的环境里，多了一条读 `~/.dsh/sessions` 的独立链路，且官方说明**新装默认从现有 transcript 末尾开始，不做历史导入**。

## 四、claude-mem 值得借鉴的（按性价比）

| 优先级 | 项 | 为什么值得 | 成本 | 置信度 |
|---|---|---|---|---|
| **P0** | **重建回归测试** | 对比最扎眼的一条：对方 1,020 个测试文件，本机 0 个（12 套 289 断言随 `/tmp` 丢失）。所有"硬闸"（锚点不丢、必须变短、幂等、单条制）目前只靠 README 承诺 | 按 `tests/README.md` 的既有顺序重建 5 套即可覆盖主干 | 高 |
| **P1** | **写入时采集文件字段** | claude-mem 的 `filesRead`/`filesModified` 让"这个文件以前改过什么"可查；dsh-structured-memory 的 `save_memory` 输出里加 `files` 数组并进 FTS 列，改动很小 | 小（一次 schema 兼容 + FTS 列） | 高 |
| **P1** | **把检索用法移进 skill** | `save_memory` 的描述实测 **2,009 字符**、**每步都占上下文**；对方把三层检索指南放进 `mem-search` skill 按需加载。迁移后可省下常驻 token | 中（要确认 DSH `skills.register` 的加载语义） | 中 |
| **P2** | **timeline 视图** | 缺"围绕某条记忆的前后几步"。可在不新增存储的前提下，用已有 `sessions/*.json` + 时间戳派生 | 中 | 中 |
| **P2** | **类型化记忆** | 已有 `category`，可固定成 `decision/bugfix/security/preference` 枚举，让 `/dream` 按类型差异化保留（安全类永不自动合并） | 小 | 中 |
| **P2** | **`<private>` 式排除标记** | 教务/公文场景有现实需求：某些内容入会话但不入库 | 小 | 中 |

## 五、不该抄的

1. **全量捕获 + 每轮 summarize**。这与"零垃圾、成本可控"直接冲突：自动摘要每轮一次模型调用，且噪声在写入端产生、要到读取端折叠补救。dsh-structured-memory 的 `/dream` 是手动、有预算、有硬闸的。
2. **为语义检索引入 Chroma/uv**。多一条 Python 依赖链换向量召回；在"索引已经全量注入上下文"的设计下边际收益很小。
3. **常驻 worker + 账户体系**。hosted observer、云同步、TeamBrain 与"全本地、可 git"的定位互斥；且 DSH 场景下会形成第二条读会话日志的链路。
4. **SQLite 作为唯一事实源**。放弃手改、diff、跨机搬运这三件事，对一个自用插件不划算。

## 六、自检命令

```sh
# 本机记忆库现状
jq 'length' ~/.dsh/memory/global.json
jq -s '[.[].memories[]]|length' ~/.dsh/memory/sessions/*.json
sqlite3 ~/.dsh/memory/memory.db "select count(*) from mem_idx"
du -sh ~/.dsh/memory/sessions

# claude-mem 侧事实（需 gh 已登录）
gh api repos/thedotmack/claude-mem --jq '{stars:.stargazers_count,forks:.forks,issues:.open_issues}'
gh api repos/thedotmack/claude-mem/contents/dsh --jq '.[]|.name'
gh api repos/thedotmack/claude-mem/contents/src/integrations/dsh-plugin --jq '.[]|.name'
```

## 附：本文档的两处诚实说明

- claude-mem 的 `~10x token 节省`、`102k stars` 中前者为官方自述未复现，后者随平台索引波动，均只作量级参考。
- 对比基于 v15.0.1（2026-10-20 发布）。该项目近 7 天 ≥100 commits，`dsh/` 目录与 DSH 集成文档仍在快速变动，结论有效期为阅读当日。
