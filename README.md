# dsh-structured-memory

DSH 跨会话记忆插件：用户画像 + 全局紧凑索引（运行时上下文注入，变化才注入）+ 按需会话记忆检索 + FTS5 全文搜索 + 自动备份。

版本：v2.19.6（插件名称统一为 `dsh-structured-memory`；v2.3 起注入改用 DSH 运行时上下文，v2.4 起为保存触发协议，详见「版本历史」）

## 安装

插件为 DSH bundle 层（`cordis.patch.yml` 挂载），无外部依赖（node:sqlite / fs 内置，零新依赖）。

1. 将本目录（`dsh-structured-memory/`，需含 `index.js`、`client.js`、`search-index.js`、`cordis.patch.yml`、`package.json`）作为 bundle 层装入 DSH profile：在 profile 的 `package.json` 里加 `link:` 依赖 `dsh-structured-memory`，并把它加进 `dsh.profile.bundles`（`~/.dsh/structured-memory` 软链只是旧路径别名，hmr 已直接指向真实目录）
2. **重启 DSH 进程**使 bundle JS 生效（`patchReload: live` 只热更 patch yml，不热更 JS）
3. 验证：对话中要求模型调用 `save_memory`，再发新消息确认注入出现 `<user_profile>` 与 `<global_memory_index>`

## 配置（cordis.patch.yml）

| 配置项 | 默认 | 说明 |
|---|---|---|
| `maxMemoriesPerSession` | 1000 | 单会话记忆条数上限 |
| `injectLimit` | 20 | 全局索引注入条数上限 |
| `maxInjectBytes` | 8192 | 注入总字节预算（画像最高优先，尾部裁剪） |
| `maxProfilePoints` | 100 | 画像每区块要点数上限 |
| `autoBackupMin` | 1440 | 自动备份间隔（分钟），`<=0` 禁用 |
| `backupRetainDays` | 7 | 备份保留天数，超期目录轮换删除 |
| `migration` | true | 首启迁移旧版 memories.json（迁移后改名 `.migrated-<ts>`） |
| `subagentMemoryReadOnly` | true | 子 agent 记忆只读：禁 `save_memory`/`forget_memory`，保留 `recall_memory`/`load_session_memory` |
| `saveRequireEvidence` | true | 非用户明确要求的保存必须给出证据锚（`trigger` 为 acceptance/decision/correction 时） |

> `injectLimit` 与 `maxInjectBytes` 声明为 `.volatile()`，因此可在插件页直接改写（DSH settings 服务只接受 volatile 字段）。注意 schemastery 的 `.volatile()` 让该字段在插件侧解析为一个**活单元格**（cosmokit `createVolatile`，取值为 `cell.get()`）：读取时必须解包，否则会拿到对象而不是数字——v2.6 实现即踩过此坑并已修。

## 保存触发协议（v2.4：把"值不值得记"换成"事件是否发生"）

旧描述是 "Use this when the user states … worth remembering"——内容评价题，模型在思考阶段可自行判"是"，插件看不到思维，拦不住。v2.4 改为三道闸：

**闸一 触发条件收敛为封闭枚举**（`trigger` 必填，仅四个取值，全部是"已经发生的事件"）：

| 取值 | 判定依据（为真即可，无需评价内容） |
|---|---|
| `user-request` | 用户原话要求记住（记住／记一下／记下来／存一下／别忘了） |
| `acceptance` | 用户对交付物明确验收（可以了／没问题／已生效／通过） |
| `decision` | 本会话定下一个**无法从仓库或文档反推**的取舍 |
| `correction` | 用户纠正了既有记忆 |

否定清单（写入工具描述）：正在思考是否需要记忆／中间进度／未完成的待办／仓库与上下文中已可读到／未经确认的推测。优先级：**用户明确要求 > 否定清单**（"这个问题先记下来，后面再讨论"属 `user-request`，虽为待办也应保存）。

**闸二 证据锚**：`acceptance`/`decision`/`correction` 必须带 `evidence`——用户原话片段或可核验产物（路径／命令／哈希／数字），缺失直接拒绝并说明如何补。填锚点需回查对话与产物，纯推测状态填不出，于是不会调用。`user-request` 免填（原话即锚）。开关 `saveRequireEvidence`（默认 true）。

**闸三 写入幂等**：正文按去空白／标点／大小写归一化后比对，与本会话既有记忆相同则返回 `stored: false, reason: 'duplicate …'`，不落盘。即使前两闸漏过，也不产生垃圾条目。

> 为什么是这三道：插件的可见面只有工具调用，模型"思考中触发"这一过程本身无法从代码侧观测。可做的只有两件事——把触发条件换成**可核验的事实**（闸一、闸二），以及让误触**没有代价**（闸三）。

## 插件页配置界面（v2.5）

入口：侧栏 **插件 → dsh-structured-memory → 配置**（DSH 的 `plugins.row.config` slot，key 规则为 `<包名>#<patch 行 id>`，即 `dsh-structured-memory#dsh-structured-memory`）。可人工优化的内容：

| 页签 | 可编辑 |
|---|---|
| 用户画像 | 五个区块（身份/工作/个人/技术/风格）要点的增、改、删；保存时按区块替换 |
| 全局索引 | 每条会话条目的标题、要点、分类就地编辑，可删除条目（每会话仅 1 条，注入按最近活动排序） |
| 会话记忆 | 左右两栏：左侧会话列表（可滚动、选中高亮），右侧即时显示该会话的记忆明细。可删除单条记忆或整个会话（与画像/索引共用底部「保存修改」提交，避免误删）；删除单条会**同步删除 FTS 索引行**，删除整会话会一并移除它在全局索引里的条目。右侧还有**「整理该会话」**：压缩该会话的记忆、合并同主题、删除重复与已被推翻/过时的内容 |
| 整理 | 后台调用模型压缩两层注入内容：生成建议稿 → 表格显示 before→after 与合并/丢弃明细 → 确认后应用（应用前自动快照）。详见下节 |
| 注入控制 | 索引条数 `injectLimit`、字节预算 `maxInjectBytes` 可视编辑（写回本 profile 的 Cordis patch，注释格式无损）；并**分区块估算 token**：用户画像 / 全局索引 / 实际注入合计，各给字符、字节、估算 token 与 DSH 口径 |

实现要点：

- `client.js` 采用 DSH 客户端的模块加载格式（`window.__ModuleLoader__.load({ id, factory })` + `require('react')`），**无需构建步骤**，直接作为 `exports["./client"]` 发布。
- 读写走插件自建的 **loopback bridge** `/api/dsh-structured-memory-store`：`GET` 读全量视图，`POST { ops: [...] }` 写入；仅接受 127.0.0.1 / ::1。
- **JSON 仍是唯一事实源**：界面写入的就是模型 `save_memory` 写的那两份文件，不存在第二份真相。
- 写入纳入与 `save_memory`/`forget_memory` **相同的每 root 串行锁**；只重写被改动的那一层（改全局索引不会动画像时间戳）；操作是字段级的（`profile.replace` / `global.update` / `global.remove`），不做整文件覆盖，因此并发的模型写入不会被界面回写冲掉。
- 保存后**无需重启**：注入快照的渲染缓存以文件 mtime+size 为键，下一次组装即取新内容。

### 注入量估算口径

| 列 | 含义 |
|---|---|
| 字符 / 字节 | 精确值。字节数才是注入裁剪的依据（`maxInjectBytes`）。 |
| 估算 tokens | CJK 感知折算：中日韩字符按 **0.7 token/字**、其余按 **4 字符/token**。更贴近 DeepSeek 分词的实际占用。 |
| DSH 口径 | harness 自身的固定密度估计 `text.length / 4`（见 `packages/llm/token-meter/src/estimate.ts`），对中文系统性偏低，列出以便与界面上其他上下文占用数字对齐。 |

三个区块分别计价：**用户画像**（`renderUserProfile`）、**全局索引**（`renderGlobalIndex(entries, injectLimit)`）、**实际注入合计**（`composeInjection` 按字节预算裁剪后的最终文本）。因此合计不是前两者之和的近似，而是包含"超预算时索引块整块丢弃、画像退化为首尾行"的真实结果；`trimmed` 标记会提示是否已触发裁剪。「预览」按钮按填入的条数/预算试算而**不写入**，确认后再「保存配置」。

首次启用注意：客户端插件登记表在**启动时**扫描，且负判定**重启前永久缓存**（`client-modules` 的 `resolveMeta` 命中缓存即返回）。因此给一个已安装插件**新增** `dsh.client` 声明需要**重启一次 DSH**；此后改 `client.js` 只需刷新浏览器。

## 记忆整理（v2.7）

入口：插件页 **整理** 页签。流程是**生成建议 → 人工确认 → 应用**，任何一步都不静默改写记忆。

| 步骤 | 行为 |
|---|---|
| 选模型 | **整理模型必须由操作者指定**：在页面上选 provider / model / 推理档位并保存（写入本 profile 的 Cordis patch）。未保存前「生成」按钮禁用，接口直接返回 `no-target`——插件**不会**自行挑选模型，也不会回退到会话路由 |
| 生成 | 插件自己发起一次 `ctx.llm.stream()` 调用（**不占用对话 token**），把当前画像与全局索引交给模型压缩，返回**建议稿** |
| 预览 | 表格列出画像/索引/合计的 tokens 与要点数、条目数 before → after，并列出合并了哪些条目（`fromIds`）、丢弃了哪些条目 |
| 应用 | 写入前把 `profile.json` 与 `global.json` 快照到 `memory-backup/consolidation-<ts>/`，写入后按同一套口径复核注入量 |
| 丢弃 | 建议稿直接作废；建议稿 30 分钟后过期，且**只能用一次** |

**整理历史已落盘**：每次整理（含失败）追加一条到 `~/.dsh/memory/consolidation-log.json`（最多 50 条），记录时间、模型与档位、output/合计 tokens、耗时、注入 before→after、锚点丢失数与是否退化。插件页「整理」页签显示表格，`/dream status` 显示最近 3 次——热重载或重启不再丢历史。

### 会话记忆整理（scope=session）

与注入层整理同一套机制（后台 `ctx.llm.stream` → 建议稿 → 人工确认 → 快照后写入），但语义不同：

| 项 | 注入层（画像 + 全局索引） | 会话记忆 |
|---|---|---|
| 目标 | 只压缩（省 token） | **每次把该会话的全部记忆合成一条**：删重复、删已被推翻或过时的内容（含"此前误记为…"这类沿革说明），只保留仍然有效的事实 |
| 结果形态 | 建议稿 = 多条改写后的条目 + 合并/丢弃明细 | 建议稿 = **一条正文**（界面直接显示这条正文，来源条数与 id 合并情况附在后面） |
| 锚点规则 | **硬闸**：丢失任何路径/URL/编号/数字即拒绝应用 | **信息性提示**：丢弃一条过时记忆必然带走它的旧值（如被推翻的端口号），故只列出"随丢弃移除的标识"，不阻断 |
| 体积校验 | 注入 tokens 必须下降 | 总字符必须下降（否则拒绝应用） |
| 索引同步 | 无（不动 `memory.db`） | 重写后清该会话索引行再重建存活的记忆（`indexRemove` + `indexUpsert`），不留检索幽灵 |
| 快照 | `memory-backup/consolidation-<ts>/` 下两份 JSON | 同目录下该会话的原文件 |

会话整理采用"**合成一条**"策略：模型只输出 `{"content":"...","category":"..."}`，即把该会话全部有效事实写进同一条记忆；被推翻的旧值彻底删除，不保留沿革说明。这样的结果一眼可读（界面直接展示这条正文），输出 token 也更少（实测同会话 124 vs 旧策略 176 tokens），`maxTokens` 消耗下降。保留最新条目的 id 与分类，其余 id 记入 `mergedFrom`；应用时清该会话索引行再重建这一条。

### 每会话一条记忆（v2.16）

**规则**：每个会话记忆文件**只保留一条记忆**。保存不再是"追加一条"，而是**改写这一条**：

| 行为 | 说明 |
|---|---|
| 合并方式 | 去重后追加（`normalizeMemoryText` 归一化比对；已被包含的事实直接报 `stored:false`，不重复写入） |
| 保留字段 | `id` 与 `createdAt` 不变（FTS 行原地更新），`category` 随最新保存更新，新增 `updatedAt` 与 `mergedCount`（该条已吸收的来源段数） |
| 旧多条文件 | 下次保存时**自动折叠**为一条（确定性、不调用模型），再执行本次合并 |
| 上限 | 单条 16,000 字符；**超限拒绝写入并提示先整理**，绝不静默截断 |
| 索引条目 | 仍是一会话一条，保存时同步刷新摘要（v2.14 的契约不变） |

**两种收敛手段**：

| 手段 | 何时用 | 成本 |
|---|---|---|
| 「整理该会话」（模型压缩，`scope=session`） | 需要去冗余、解决矛盾、保留可读性；**单条也适用**——合并式保存会让这一条逐渐变长变杂 | 一次 LLM 调用（实测百至数千 output tokens） |
| 「折叠为一条」（`session.collapse`，确定性） | 文件里**真的出现多条**时（手工编辑、旧版本写入、从旧备份恢复）用它零成本恢复单条形态；已在界面按条件显示，单条时不出现 | 零 LLM 成本；只做精确去重与拼接，**不减体积、不解决矛盾** |

`?doctor=1` 现在同时报告"多记忆会话"，界面「全局索引 → 修复不一致」会对其执行确定性折叠。

### 关联契约：索引与会话记忆一一对应（v2.14）

**约定**：每个 `sessions/<sessionId>.json` **恰好**对应 `global.json` 里的一条条目，`entry.sessionId` 是唯一的关联键。该契约由三处强制：

| 位置 | 强制方式 |
|---|---|
| 注入层整理 | 提示词要求"一个会话一条，不许丢弃、不许合并"，且应用前有硬闸：建议稿一旦丢弃或合并条目即 `entry-link-broken` 拒绝 |
| 会话层整理 | 应用后**刷新该会话的条目摘要**（模型额外产出 `keyPoint`），条目缺失时补建——重写记忆不会让会话失去索引 |
| 插件页删除 | 已关联会话的条目**不允许单独删除**（`global.remove` 拒绝），只能「会话记忆 → 删除整会话」；孤儿条目可单独删 |

**一致性自检与修复**：`GET /api/dsh-structured-memory-store?doctor=1` 报告四类问题——缺条目的会话、孤儿条目、空会话、重复条目；界面「全局索引 → 校验关联 / 修复不一致」可一键修复（补建条目用该会话首条记忆生成摘要）。修复是幂等的。

**存储与注入的分工（v2.15 起：全部条目始终注入）**：完整性归存储层（所有会话都必须有条目）；注入层**始终列出全部条目**，不存在"未注入条目"。`injectLimit` 的语义改为"**带要点条数**"——前 N 条（按最近活动）显示要点，其余仅列标题；`maxInjectBytes` 超预算时**逐级降级**：完整要点 → 要点截断到 24 字 → 仅标题 → 一行计数提示（`共 N 条，请用 recall_memory(scope:"global") 列出`），**索引块永不被整块丢弃**（此前会 `texts.pop()` 丢掉索引，那正是记忆变得不可发现的路径）。注入文案同时写明两条读取路径与成本差：`recall_memory(query)` 全文检索便宜、`load_session_memory(sessionId)` 整会话可能上万 token。

### 注入层的形状：画像五段、索引分条（v2.13）

注入层整理的输出形状是刻意不对称的：

| 层 | 形状 | 理由 |
|---|---|---|
| 用户画像 | 五个分区**各自合成一段连贯陈述**（字符串，不是分条） | 画像每次都注入，段落化后体积最小、可读性最好；段内用中文分号分隔，不提行、不以"·"开头，单段 ≤300 字，即使用户是"逻辑清晰、论据充分"的偏好也能一眼读完 |
| 全局索引 | **保持分条**，仍按主题条目输出（`fromIds` 合并同类） | 索引承担 `recall_memory(scope:'global')` 的发现职能，条目与会话的对应关系不能丢；压缩靠合并同类条目实现 |

写入端对形状是宽容的：分区值为字符串→存为一条；单元素数组→仍是一条；旧的多条数组→原样保留（降级，不丢信息）。这些形状都有单元测试覆盖。

**三条硬约束**（服务端强制，界面同步显示）：

1. **拒绝退化**：整理后注入 tokens 必须下降，否则不给出「应用」。
2. **拒绝丢失锚点**：路径、文件名、URL、哈希、编号、数字、CIDR 等标识在整理后必须仍在文本中，缺一个即拒绝应用并列出缺失项。
3. **一次性**：应用或过期后建议稿失效，重复应用返回 `no-draft`。

**无损性**：整理只改注入层（画像 + 全局索引）。被合并或丢弃的索引条目，其**会话记忆仍完整保存在 `sessions/*.json`**，`recall_memory` 与 FTS 检索不受影响——整理牺牲的是注入可见性，不是记忆本身。

### 对话里的 `/dream` 命令

除插件页按钮外，整理也可以在聊天里触发（服务端命令，结果直接回在对话中）：

| 命令 | 行为 |
|---|---|
| `/dream` | 生成整理建议并在对话里报告：用量（output/合计/耗时）、画像与索引的 before→after、合并与丢弃明细、锚点校验结果 |
| `/dream apply` | 写入待处理的建议稿（同样先快照、同样拒绝退化与锚点丢失） |
| `/dream discard` | 丢弃待处理建议稿，不写任何数据 |
| `/dream status` | 显示当前整理模型、是否有待处理建议稿、上次整理的用量与结论 |

命令沿用**你在插件页保存的模型**；未选择时 `/dream` 返回错误提示，不会自行挑模型。

**客户端行为（实测踩坑）**：带参数的命令**必须在注册时声明 `input`**。DSH 客户端的 `matchEnter` 对未声明 `input` 的命令会拒绝认领"带参数的行"（`if (!bare) return undefined`），于是 `/dream status` 会被静默当成普通消息发给模型——菜单里能看见命令、但手打不执行，正是这个原因。本插件已声明 `input: { hint: 'apply | discard | status；留空则生成整理建议' }`（`feedback`/`goal`/`permission`/`plan` 等内置命令同样声明）。

因此用法是：输入 `/dream` 回车→**认领**该命令（草稿里保留 `/dream `），再输入 `status`/`apply`/`discard` 回车执行，或直接回车＝生成建议；从 `/` 菜单选中 `dream` 同理。

排查入口：`GET /api/dsh-structured-memory-consolidate?commandsFor=<sessionId>` 会列出某会话可见的命令及其是否声明 `input`。

### 推理档位与"关掉思考"

档位来自**该路由的模型目录**（`ctx.llm.resolveModelInfo(provider, model).reasoning.efforts`），页面上的档位下拉就是它的原样呈现。以 `opencode-go` 实测为例：

| 模型 | 可用档位 | 能否关掉推理 |
|---|---|---|
| `deepseek-v4.1-flash` | `low` / `high` / `max` | **不能**（无 `off`） |
| `deepseek-v4-pro` | `off` / `high` / `max` | 能 |
| `glm-5.1` | `off` / `minimal` / `low` / `medium` / `high` | 能 |
| `qwen3.8-flash` | `off` / `minimal` / `low` / `medium` / `high` | 能（默认即不思考，实测 output 1,525） |
| `mimo-v2.6-flash` / `minimax-m3` | 含 `off` | 能 |

该路由共 28 个模型，其中 17 个声明了 `off`。**要给 `deepseek-v4.1-flash` 关掉思考是做不到的**——只能退一档到 `low`，或改选声明了 `off` 的模型。

**成本参考（实测，同一输入：29 条画像要点 / 10 条索引 / 注入 1427 tok）**：

| 档位 | 用时 | output tokens | total | 注入压缩 | 效果差异 |
|---|---|---|---|---|---|
| `low` | 50.5s | **7,939** | 10,291 | 1427 → **1222（−14%）** | 合并略粗 |
| `high` | 77.1s | 11,498 | 13,850 | 1427 → **1205（−16%）** | 合并更精准、标题保留更多细节 |
| 不指定档位（网关默认） | 87.6s | 14,867 | 17,219 | 1427 → 1364（**−4%**） | 最保守，几乎不合并 |

**跨次波动提醒**：同一档位不同批次的 output 实测可差近一倍（`low` 两次样本：7,939 / 14,843），因此上表的百分比宜看作紧邻对照的结论，**以每次运行报告的实际用量为准**（`/dream status` 与插件页都会显示）。

**结论：日常用 `low`**——output 只有 `high` 的 69%、快 26.6 秒，压缩效果仅差 17 tokens；而**不指定档位最差**（最贵且几乎不压缩），所以务必显式选档位。真实 prompt 约 **2,352 tokens**（早期观测到的 `input 45 + cacheRead 2,560` 是复用会话前缀缓存造成的表象）。

`qwen3.8-flash`（非推理）一次 output **1,525** / 25s，压缩率更高（−45%），但当时因丢失锚点被安全闸拒绝。

**模型选择与成本**：默认沿用当前会话路由的模型（`agents` 服务解析，或最近一次记忆工具调用所用路由）；也可在 profile patch 里固定：

```yaml
# dsh-structured-memory 行 config 内
consolidationProvider: opencode-go
consolidationModel: qwen3.8-flash   # 建议用非推理模型
consolidationMaxTokens: 32768
```

实测（`deepseek-v4.1-flash`，推理型）：需 32,768 `maxTokens`、约 **2 分钟**、约 3 万 token——推理型模型会把预算几乎全花在思考上（8,192 预算下 100% 打满思考、零输出）。**整理是纯改写任务，配一个非推理模型更划算**。

**实测效果与已知限制**（2026-10-10，13 条索引 / 29 条画像要点）：画像 984 → 884 tokens、索引 533 → 417 tokens、合计 1517 → **1301 tokens（−14%）**，要点 29 → 15、条目 13 → 10，无退化、无锚点丢失。但**提示词中"降到 60% 以下"的目标未达成**——锚点必须全保留，压缩幅度天然受限。后续可做：多轮整理（把上一轮结果再压一次）、分级激进度（对明确低价值的条目放宽锚点要求）。

## 子 agent 策略（v2.3 实测后确定）

- **注入**：与主 agent 相同（画像 + 全局索引）。实测父子系统提示词长度相同（5,752 = 5,752）、工具清单相同（30 = 30）——DSH 的设计本就是"父子提示词一致"，子 agent 仅多一条 348 字符的委派说明
- **写权限**：**只读**。子 agent 调用 `save_memory`/`forget_memory` 会被拒绝，错误信息提示"把结论回报给父 agent，由父 agent 写入"
- **理由**：①子 agent 曾可 `forget_memory` → 能删除父 agent 的记忆（破坏性、风险不对称）；②子 agent 与父 agent 并发 `save_memory` 时对 `global.json` 是**无锁读-改-写**，存在丢更新竞态
- **识别方式**：`agent.session.header.origin === 'subagent'` 或 `delegationDepth > 0`

## 存储

JSON 文件为唯一事实源（位于 `$DSH_HOME/memory/`，通常即 `~/.dsh/memory/`）：

> `$DSH_HOME` 本身就是 DSH 状态目录（内含 `profiles/`、`logs/`），记忆库直接挂在它下面。v2.3.1 修正：旧写法把 `$DSH_HOME` 当作用户主目录、再拼一层 `.dsh`，会得到 `~/.dsh/.dsh/memory` 并静默分裂成两个库。未设 `DSH_HOME` 时回退 `~/.dsh/memory`。若启动时发现旧形态目录仍存在，日志会提示。

- `profile.json` —— 用户画像（identity/work/personal/technical/style 五区块）
- `global.json` —— 每会话 1 条极简索引（title/keyPoints/keywords）
- `sessions/<sessionId>.json` —— 各会话完整记忆。单条字段：`id` / `content` / `category` / `createdAt` / `updatedAt` / `mergedCount` / `files?` / `mergedFrom?`；`files: [{path, action:'read'|'modified'}]` 多次保存取并集（`modified` 覆盖 `read`，上限 50 条），并进入 FTS 索引供按路径召回
- `memory.db` —— 派生 FTS5 索引（**不备份**，可随时重建；不可用时 recall 自动降级 JSON 子串扫描）
- `memory-backup/YYYY-MM-DD/` —— 自动备份（profile/global/sessions 复制，7 天轮换）

## 工具

| 工具 | 用途 |
|---|---|
| `save_memory` | 存记忆到当前会话层 + 维护全局条目（须带 `trigger`，自动保存须带 `evidence`；可带 `profileUpdate` 合并画像、`files` 记录文件坐标；`<private>` 内容入库前剔除）。`trigger='correction'` + `supersedes` 定点纠正旧行，`sessionId` 可纠正过去会话 |
| `recall_memory` | 按 scope（profile/global/session/all/**timeline**）+ query（FTS5/LIKE，覆盖正文与文件路径）检索记忆 |
| `load_session_memory` | 按需加载指定会话完整记忆进当前对话 |
| `forget_memory` | 删除单条记忆或整会话（同步全局与索引） |

## 注入策略（v2.3：运行时上下文 + 变化检测）

- **注册方式**：`ctx.systemPrompt.context({ name: 'dsh-structured-memory', order: 130, text })` —— 与系统提示词/工具同策略（`inject` 需含 `systemPrompt`）
- **每步重新渲染，但只在变化时注入**：DSH 的 `RuntimeContextProjection` 比对渲染结果与上次快照，相同则不产出任何消息
  - 实测：92 步会话中 DSH 自身运行时上下文只注入 1 次；本插件改造前注入 92 次（累积 62,062 tokens，占上下文 27.5%），改造后同口径降至 1 次
- **跨会话即时可见**：其他会话 `save_memory` 改动 `global.json` → 本会话下一步渲染不同 → 恰好产出 1 条更新（无需重启、无需重开会话）
- **同步渲染 + mtime 戳**：`PromptContext.text` 是同步函数，故用 mtime+size 校验：文件未变直接复用缓存渲染结果（不解析、不重渲染）
- **降级路径**：`systemPrompt` 服务不可用时，退回 pre-step 注入，但仅在渲染文本变化时追加
- **不注入**：当前会话 `<session_memory>`（会话消息历史已在上下文中）；需要细节时模型调 `recall_memory(query)` / `load_session_memory`

## 检索协议与 skill（v2.20）

检索用法长文从工具描述移进 runtime skill `structured-memory`（`skill.js`），由 `ctx.skills.register` 注册：会话 skill 目录里只留一行描述，正文按需加载。宿主没有 skills 服务时自动回退到完整长描述，行为不变。

实测常驻描述（save + recall + load）：**2,792 → 1,715 字符（−39%）**；`save_memory` 单条 2,009 → 1,237。

> 顺带修掉一个 v2.20 之前的缺陷：`save_memory` 描述尾部的 `${SAVE_MEMORY_CONTENT_RULE}` 写在双引号字符串里、**从未展开**，模型看到的是这个 26 字符的占位符而不是 831 字符的内容规则。回退路径现在显式拼接规则（长文 2,813 字符），并有测试钉住「不得出现未展开占位符」。

## 记忆纠正（v2.22）

此前 `trigger: 'correction'` 只是枚举里的一个词：实现上和普通保存一样，只做去重追加，于是过期或记错的内容只能被**叠加**、不能被**替换**。

现在 `correction` 是一个真正的写操作：

```text
save_memory({
  trigger: 'correction',
  supersedes: ['部署端口是 8080'],
  content: '部署端口是 3000',
  evidence: '用户：端口已改为 3000',
  sessionId: '<过去会话 id>'   // 可省略，省略即当前会话
})
```

| 规则 | 行为 |
|---|---|
| 匹配 | `supersedes` 每条片段与存储内容**逐行**比对，规范化（忽略大小写/空格/标点）后包含即命中 |
| 删除粒度 | 命中行**整行删除**，其余行原样保留 |
| 未命中 | 直接拒绝，并提示用 `recall_memory` 取原文或到插件页整条重写——不做模糊替换 |
| `supersedes` 缺失 | `trigger='correction'` 必须带 `supersedes`（上限 10 条），否则拒绝 |
| `sessionId` | 只在 `correction` 时允许；用于纠正过去会话的记忆，写入后同步该会话的全局条目与 FTS 行 |
| 体积 | 改动先在副本上预演，超过 16,000 字符整体拒绝，不产生半截写入 |
| 审计 | 写前快照 `memory-backup/corrections/<时间戳>-<会话>.json`；`corrections-log.json` 追加一条（上限 200） |
| 字段 | 保留 `id` / `createdAt`，新增 `correctedAt` / `correctedCount` |
| 闸门 | 仍需 `evidence`（闸二）；子 agent 仍只读；`<private>` 照旧在写入前剔除 |

**边界**：按整行删除（同一行混着两条事实时会一起删）；不含画像条目（画像用页面编辑或 `/dream` 整理）；不做整条重写（页面已有「重写」）。

## 类型化记忆（v2.21）

`category` 对**模型写入**归一化为 `decision | bugfix | security | preference | general`（认中英别名，含旧标签）。存量数据、导入 bundle 与插件页手写值不被改写——页面是逃生口，这一点在测试里钉住。

`/dream` 的类型差异是硬闸而不是提示词：合成结果里 `security` 类记忆一旦丢失路径/命令/编号等锚点，应用阶段直接拒绝（`lost-security`）；合成本身的类型取素材中最高优先级（security > decision > bugfix > preference > general）。

## 隐私标记（v2.21）

会话里的 `<private>…</private>` 只在对话中存在：保存、插件页写入、`/dream` 草稿、导入四条路径共用 `stripPrivateSpans`，入库前切除。未闭合的 `<private>` 会丢弃其后全部文本（半截标签不允许泄漏）。已入库内容不会被回溯脱敏——需要清理请用 `forget_memory` 或页面删除。

## 时间轴（v2.21）

`recall_memory({scope:'timeline', sessionId:'<锚点>', limit:9})` 返回锚点周围的会话窗口（`limit` 是**行数**）。数据完全派生：`global.json` 的 `lastActivity` + `sessions/*.json` 的 `updatedAt`/`files`，不新增存储。只有会话文件、没有索引条目的会话也会出现（`linked:false`），与 `?doctor=1` 的链接审计口径一致。

## 版本历史

| 版本 | 内容 |
|---|---|
| v1 | 单层平铺记忆（跨会话完整污染，已废弃） |
| v2 | 两级记忆：全局索引 + 会话层，按需加载，旧数据迁移 |
| v2.1 | 用户画像 profile.json + save 时画像更新判断 |
| v2.2 | FTS5 检索 + 自动备份 + 方案 A 注入策略（会话记忆按需检索） |
| v2.3 | 注入机制重构：改用 DSH 运行时上下文（变化才注入），92 步注入从 92 次降至 1 次；子 agent 记忆收紧为只读 |
| v2.3.1 | 修正记忆根解析：`$DSH_HOME` 是 DSH 状态目录而非用户主目录，旧写法得到 `~/.dsh/.dsh/memory` 并静默分裂成两个库；新增旧形态残留库的启动告警 |
| v2.4 | 保存触发协议：`trigger` 封闭枚举（必填）+ 自动保存的证据锚 + 写入幂等；`saveRequireEvidence` 开关 |
| v2.5 | 插件页配置界面：免构建 `client.js` + loopback bridge `/api/dsh-structured-memory-store`，可人工编辑用户画像与全局索引 |
| v2.16.2 | 模型整理后的单条记忆补齐 `updatedAt`/`mergedCount`（与保存路径字段一致） |
| v2.16.1 | 「折叠为一条」仅在记忆多于一条时显示；「整理该会话」取消"≥2 条"限制（单条同样需要压缩） |
| v2.16 | 每会话只保留一条记忆：保存改写该条（去重追加 + mergedCount），旧多条文件自动折叠，单条上限 16,000 字符；新增确定性 `session.collapse`（零 LLM 成本）；已有 9 个会话经模型压缩折叠为一条 |
| v2.22.0 | 记忆纠正：`trigger='correction'` 从"空枚举"变成真写操作（`supersedes` 定点删除旧行 + 追加新事实，支持 `sessionId` 跨会话纠正）；写前快照 + `corrections-log.json` 审计；体积超限整体拒绝 |
| v2.21.1 | P0 回归重建：注入契约 / 单条制 / 会话桥 / 导出导入 四套（共 95 条用例，逐套变异验证）。修复：桥接/导入/整理重索引时丢失 `files`（按路径召回失效）、未传 `category` 的保存会覆盖已有标签、注入层极端预算下丢失 `<user_profile>` 开标签、编辑器会话详情不返回 `files`；`injectionMetrics` 改为导出以便测试 |
| v2.21 | `category` 收敛为五值枚举（模型写入归一化、存量不改写）；`/dream` 类型优先级 + 安全类丢锚点硬闸；`<private>` 四条写入路径统一剔除；`recall_memory` 新增 `scope=timeline` |
| v2.20 | 记忆采集文件坐标（`files`，FTS 覆盖路径）；检索长文移入 runtime skill `structured-memory`，常驻工具描述 2,792 → 1,715 字符；修掉未展开的 `${SAVE_MEMORY_CONTENT_RULE}` 占位符；`memory.db` 新增 `files` 列并自愈重建 |
| v2.19.6 | 修复插件名称：统一为 `dsh-structured-memory`，记忆数据目录与格式不变 |
| v2.15 | 注入全量列出索引条目（消除"未注入条目"）+ 字节预算逐级降级（索引不再整块丢弃）+ `injectLimit` 语义改为"带要点条数"；注入文案写明检索与整会话加载的成本差 |
| v2.14 | 索引 ↔ 会话记忆一一对应：注入层整理禁止丢/并条目（硬闸）、会话层整理刷新并补建条目、`global.remove` 仅限孤儿；新增 `?doctor=1` 自检与 `doctor.repair` 修复（把库从 13 会话/6 条目修成 13↔13） |
| v2.13 | 注入层画像改为"五分区各合成一段"（索引仍分条）；写入端兼容字符串/单元素数组/旧数组；实测同库 output 8,939 → 4,271 tokens（−52%） |
| v2.12 | 会话整理策略改为"**合成一条**"：N 条 → 1 条，彻底删除被推翻的旧值与沿革说明；界面直接展示合成后的正文 |
| v2.11 | 会话记忆界面改为左右两栏（列表可滚动、选中高亮、明细即时可见）；新增**会话记忆整理**（scope=session：压缩 + 去矛盾，锚点改为信息性提示，FTS 同步重建） |
| v2.10 | 会话记忆浏览/删除（含 FTS 索引同步与整会话清理）；整理历史落盘 `consolidation-log.json` 并在页面/`/dream status` 展示 |
| v2.9.1 | `/dream` 声明 `input`（DSH 客户端要求：带参数的命令必须声明 input，否则带参数的行会被当成普通消息） |
| v2.9 | `/dream` 对话命令：生成 / apply / discard / status，四种用法均实测；写入仍需二次确认 |
| v2.8.1 | 建议稿内容随响应返回（`proposed`，便于比对/后续 diff 视图）；README 补 low/high/默认三档实测对照 |
| v2.8 | 整理模型由操作者指定（provider/model/推理档位三级选择，保存进 profile patch）；移除一切隐式模型回退；未配置即拒绝生成 |
| v2.7 | 记忆整理：后台一次性 `ctx.llm.stream` 生成压缩建议稿，人工确认后应用；三条硬约束（拒绝退化 / 拒绝丢失锚点 / 建议稿一次性） |
| v2.6 | 注入控制页签：可视编辑 `injectLimit` / `maxInjectBytes`（经 settings 服务写回 profile patch），并按区块估算 token 消耗与预算占用 |

## 测试

```sh
npm test   # node --import ./tests/lib/register.mjs ./tests/run.mjs
```

测试不需要 DSH 运行时：`tests/lib/register.mjs` 用 `module.registerHooks` 把 `@deepseek-ai/*` 映射到 `tests/lib/stubs/`，因此 `index.js` 能被纯 node import。所有用例使用临时记忆根（`memoryDir`），**不读写 `~/.dsh/memory`**。

## 备份

- 插件代码备份：`index.js.bak-v1/v2/v3/v2.2/v2.2.1`（插件目录非 git，沿用 .bak 惯例）
- 设计文档：开发期记录（本机维护；仓库内发布的是 README 与代码本身）

## 运行要求

- DSH（bundle 层挂载），Node ≥ 20
- `node:sqlite`（Node ≥ 22.5）为**可选**：`search-index.js` 用动态 `import('node:sqlite')`，缺失/不可用时自动降级为 LIKE + JSON 子串检索，插件功能不受影响

### 源码热重载（rc.2 起，可选）

DSH 0.2.0-rc.2 的 `@deepseek-ai/dsh-hmr` 支持插件源码热替换，但 base bundle 默认 `root: []`（仅配置监视）。在自己的 profile patch 里显式指定模块根即可，改 `index.js` 后无需重启：

```yaml
- id: hmr
  disabled: false
  config:
    root:
      - /Users/ryo/vibing/dsh_plugin_dev/dsh-structured-memory   # 真实源码目录（~/.dsh/structured-memory 为旧路径别名）
    ignored: []                          # 必须置空：baseDir 相对路径含 .dsh 段，默认 **/.* 会误伤
```

实测（2026-10-10）：写盘到重挂 ≈ 1 秒，进程 pid 不变；语法错误时**不炸进程**，旧模块继续服务（hmr 在导入失败后回滚并保留原插件），改回即恢复。日志经 cordis logger 打到启动终端。注意：替换已安装包版本仍需重启；重载会改变后续请求前缀（KV cache 失效一轮）。

## 许可证

MIT（见 `LICENSE`，版权行 `Copyright (c) 2026 Ryo`）

## 发布到 npm

包名即 `dsh-structured-memory`（原名 `dsh-memory` 在 npm 上已被占用）。改名要把**五处**一起改，漏一处不是"名字不一致"，而是装不上或配置静默丢失：

| 位置 | 字段 | 为什么必须改 |
|---|---|---|
| `package.json` | `name` | 同时决定 npm 包名、profile 依赖名、bundle 名 |
| `index.js` | `export const name` | cordis 运行时身份（日志与标签）；与包名脱节不影响加载，但会误导排查 |
| `cordis.patch.yml` | `insert[].name` | **模块说明符**：loader 按它在 profile 的 `node_modules` 里取包，不等于包名即解析失败 |
| `cordis.patch.yml` | `insert[].id` | 插件页 slot key = `<包名>#<行 id>`，改名后 `client.js` 注册的 `key` 要同步 |
| profile | `dependencies`、`dsh.profile.bundles`、profile 层 `cordis.patch.yml` 的 `id`/`name` | 覆盖行按 `id` 匹配、按 `name` 校验；不一致会被跳过，配置**静默丢失** |

改完在 profile 目录 `pnpm install` 重建 link（并清掉 `node_modules/` 下旧名软链），再重启 DSH。

> 易错点（2026-10-23）：`insert[].name` 不是任意标识，它被 loader 当模块说明符解析（见 `@deepseek-ai/cordis-plugin-include` 与 boot 的 bare-name 规则）。因此此前"改名不必动 `cordis.patch.yml`"的判断是错的——只有 `export const name` 可以不跟着改。
