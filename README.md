# dsh-structured-memory

DSH 跨会话记忆插件。把"每次都要用的信息"与"偶尔才要查的信息"分层存放：用户画像与全局索引每轮注入，会话记忆按需检索。

零外部依赖（`node:fs` / `node:sqlite` 内置），JSON 文件为唯一事实源，派生索引随时可重建。

## 设计原理

### 三层结构

| 层 | 内容 | 何时进入上下文 | 体量控制 |
|---|---|---|---|
| 用户画像 | 身份 / 工作 / 个人 / 技术 / 风格 五个区块 | 每轮注入 | 每区块合成一段散文 |
| 全局索引 | 每个会话一条极简条目（标题 + 摘要） | 每轮注入 | `injectLimit` + `maxInjectBytes` |
| 会话记忆 | 各会话的完整记忆 | **不注入**，需要时按 `sessionId` 取 | 按需，单条上限 16,000 字符 |

分层的依据是成本差：画像与索引是"每轮都付"的固定开销，必须极小；会话明细可能上万 token（实测 12 条记忆 ≈ 7.9k token），只在明确需要时加载。

### 每会话一条记忆

每个会话在 `sessions/<sessionId>.json` 里**只保留一条记忆**。保存不是追加条目，而是**改写这一条**：

- 新内容经归一化比对后追加（已包含的事实直接报 `stored: false`，不重复写入）；
- `id` 与 `createdAt` 保持不变，FTS 索引行原地更新；`category` 随最新保存更新，另记 `updatedAt` 与 `mergedCount`（该条已吸收的来源段数）；
- 若文件中出现多条（手工编辑、旧版本写入、从旧备份恢复），保存时会先做一次**确定性折叠**（去精确重复 + 拼接，不调用模型）；
- 单条达到 16,000 字符时**拒绝写入并提示先整理**，不静默截断。

一条会随保存变长，因此"整理"是常规维护动作，而非一次性操作。

### 索引与会话记忆一一对应

`global.json` 的条目以 `entry.sessionId` 为唯一外键，与 `sessions/<sessionId>.json` **一一对应**：条目是会话记忆的唯一把手，条目消失则该会话的记忆只剩全文检索可达。三处强制该契约：

| 位置 | 强制方式 |
|---|---|
| 注入层整理 | 提示词要求"一个会话一条，不许丢弃、不许合并"；应用前硬闸，一旦丢/并条目即拒绝 |
| 会话层整理 | 应用后**刷新该会话条目摘要**；条目缺失时补建 |
| 插件页删除 | 已关联会话的条目**不允许单独删除**，只能连会话一起删；孤儿条目可单独删 |

一致性自检 `GET ?doctor=1` 覆盖五类问题：缺条目的会话、孤儿条目、空会话、重复条目、多记忆会话；一键修复是幂等的。

### 注入：全量列出 + 逐级降级

索引**始终列出全部条目**（不存在"未注入条目"这个状态），`injectLimit` 只决定前 N 条（按最近活动）是否显示摘要，其余仅列标题。超出字节预算时按级降级：

完整摘要 → 摘要截断 → 仅标题 → 一行计数提示

**任何情况下索引都不整块丢弃**——静默丢弃会让记忆"存在但不可发现"。降级到最后一档时，提示模型先 `recall_memory(scope:"global")` 取列表。

### 写入：三道闸

插件的可见面只有工具调用，模型"思考中触发保存"无法从代码侧观测。因此把触发条件换成**可核验的事实**，并让误触**没有代价**：

1. **触发条件是封闭枚举**，全部是"已经发生的事件"：`user-request`（用户原话要求记住）、`acceptance`（用户明确验收）、`decision`（定下无法从仓库/文档反推的取舍）、`correction`（纠正既有记忆）。否定清单写进工具描述：正在思考是否值得记、中间进度、未完成待办、仓库与上下文中已可读到、未经确认的推测。
2. **证据锚**：`acceptance` / `decision` / `correction` 必须给出用户原话片段或可核验产物（路径、命令、哈希、数字），缺失即拒绝。`user-request` 免填（原话即锚）。
3. **写入幂等**：正文归一化后比对，与既有记忆重复则不落盘。

另外有一条**内容分工**（写在工具描述与会话整理提示词里）：会话记忆只留**结论、当前状态、不可反推的取舍、坐标（路径/命令/编号）与指针**；过程性叙述、实测数字、踩坑经过、沿革说明与提交哈希属于项目文档，**不写入记忆**——记忆里写一次指针，而不是抄一遍细节。摘要超限时按**子句边界**截断并加省略号（不会把词切成两半）；含路径/版本号等关键标识的摘要上限放宽到 100 字。指针须写成**绝对路径**（相对路径跨会话不可解析），并显式引导"记忆不足以解决问题时进一步读取该文档"；会话整理会**保留该指针**（提示词中列为硬规则），不会因压缩而丢掉。

### 读取：两条路径，成本差一个量级

| 路径 | 用途 | 成本 |
|---|---|---|
| `recall_memory(query)` | 全文检索命中具体记忆 | 便宜（FTS5 索引） |
| `load_session_memory(sessionId)` | 加载某会话完整记忆 | 可能上万 token，优先用上一条 |

### 整理：后台生成建议稿，人工确认后写入

整理由模型完成，但**不自动生效**：生成建议稿 → 人工确认 → 写入前把原文件快照到 `memory-backup/consolidation-<ts>/`。硬约束：体积必须下降才允许应用；注入层整理还会拒绝丢失关键标识（路径、URL、编号、数字）。

## 主要功能

| 功能 | 说明 |
|---|---|
| 用户画像 | 五区块结构化画像，随会话累积更新，可人工编辑 |
| 全局索引 | 每会话一条极简条目，注入按最近活动排序 |
| 会话记忆 | 每会话一条；保存改写、确定性折叠、模型压缩三种维护方式，另有**整条重写**（保留 id 与 createdAt，重置 `mergedCount`，同步 FTS 与索引摘要） |
| 全文检索 | FTS5（`node:sqlite`）为主，不可用时自动降级为 LIKE + JSON 子串扫描 |
| 记忆整理 | 注入层（画像 + 索引）与会话层（`scope=session`）两套；建议稿 + 人工确认 + 快照 |
| 对话命令 | `/dream`：生成建议 / 应用 / 丢弃 / 查看状态 |
| 插件页 | 侧栏「插件 → 本插件 → 配置」四个页签：用户画像、全局索引、注入控制、会话记忆（含整理与校验） |
| 一致性自检 | 关联、空会话、重复条目等多类巡检与幂等修复 |
| 导出 / 导入 | 打包为带校验和的 JSON bundle（默认写入 `memory/transfer/`，也可指定位置）；导入前预检、默认合并、写前快照、可回滚 |
| 插件页「数据」 | 图形化完成同一套流程：导出（范围 / 保存位置 / 体积预估）、导入（检查 → 确认 → 结果 → 回滚）、导入快照列表 |
| 会话血缘 | fork 出的会话写入其血缘会话的记忆，**不新增条目**；跨机导入的记忆标"待匹配"但不影响读取 |
| 自动备份 | 按间隔备份 `profile.json` / `global.json` / `sessions/`，超期轮换 |
| 子 agent 只读 | 子 agent 可检索但不可写入，避免与父 agent 并发丢更新 |
| 并发安全 | 全局索引读-改-写串行化 |

## 使用

### 安装

1. 把本仓库作为 bundle 层装入 DSH profile（目录需含 `index.js`、`client.js`、`search-index.js`、`cordis.patch.yml`、`package.json`）；
2. **重启 DSH 进程**使 bundle JS 生效（profile patch 的 `patchReload: live` 只热更 yml，不热更 JS）；
3. 验证：对话中让模型调用 `save_memory`，再发一条新消息，上下文中应出现 `<user_profile>` 与 `<global_memory_index>`。

### 配置项

| 配置项 | 默认 | 说明 |
|---|---|---|
| `maxMemoriesPerSession` | 1000 | 历史遗留的会话内条数上限（当前单条制下不构成约束） |
| `injectLimit` | 20 | **带摘要条数**：前 N 条显示摘要，其余仅列标题 |
| `maxInjectBytes` | 8192 | 注入总字节预算，超预算按级降级 |
| `maxProfilePoints` | 100 | 画像每区块要点上限 |
| `autoBackupMin` | 1440 | 自动备份间隔（分钟），`<= 0` 禁用 |
| `backupRetainDays` | 7 | 备份保留天数，超期轮换 |
| `migration` | true | 首启迁移旧版 `memories.json`（迁移后改名 `.migrated-<ts>`） |
| `subagentMemoryReadOnly` | true | 子 agent 写入只读 |
| `saveRequireEvidence` | true | 非用户明确要求的保存必须带证据锚 |

`injectLimit` 与 `maxInjectBytes` 声明为 `.volatile()`，可在插件页直接改写——DSH settings 服务只接受 volatile 字段。注意 `.volatile()` 字段在插件侧是**活单元格**，读取时必须解包后才能当作数字使用。

### 工具

| 工具 | 用途 |
|---|---|
| `save_memory` | 写入当前会话记忆（改写那一条）并维护全局条目；须带 `trigger`，必要时须带 `evidence`；可附带 `profileUpdate` 合并画像 |
| `recall_memory` | 按 `scope`（profile/global/session/all）与 `query` 检索 |
| `load_session_memory` | 把指定会话的完整记忆载入当前对话 |
| `forget_memory` | 删除单条记忆或整个会话（同步索引与条目） |

### 对话命令 `/dream`

| 命令 | 行为 |
|---|---|
| `/dream` | 生成整理建议，并在对话内报告用量与 before → after |
| `/dream apply` | 应用待处理建议稿（先快照） |
| `/dream discard` | 丢弃建议稿，不写数据 |
| `/dream status` | 显示整理模型、待处理状态与历史 |

命令沿用**插件页保存的整理模型**，插件不会自行挑模型；未配置时返回错误提示。

### 导出与导入（迁移 / 备份 / 合库）

**两种入口**：插件页「插件 → 本插件 → 数据」页签（图形化，推荐）与命令行。两条入口调用同一套接口、同一套规则。

- **数据页签 · 导出**：选范围（全量 / 仅画像 / 仅会话，可勾选具体会话 + 关键词过滤），看体积预估，选保存位置（默认交换目录 / 自定义路径），可选导出后在访达中定位；
- **数据页签 · 导入**：从交换目录下拉选择或填绝对路径 → **检查**（预检报告：新增/合并/跳过/替换、将补建条目、拒绝的孤儿条目）→ **导入**（两步确认，写入前自动快照）→ 结果含契约校验与「回滚本次导入」；
- **数据页签 · 导入快照**：列出可回滚的快照，一键还原。

命令行等价用法：

```bash
# 导出：默认全量（画像 + 索引 + 全部会话），也可按会话 / 关键词 / 分类裁剪
node tools/memory-transfer.mjs export
node tools/memory-transfer.mjs export --session <sessionId> --no-profile

# 保存位置：默认写入交换目录；也可指定文件、指定目录，或导出后在访达中定位
node tools/memory-transfer.mjs export --out ~/Desktop/mem.json
node tools/memory-transfer.mjs export --dir ~/Downloads
node tools/memory-transfer.mjs export --reveal

node tools/memory-transfer.mjs list                    # 查看交换目录
node tools/memory-transfer.mjs preview <file>          # 预检：将新增/合并/跳过/拒绝什么（不写数据）
node tools/memory-transfer.mjs import  <file> --yes    # 确认后写入（自动快照）
node tools/memory-transfer.mjs rollback <snapshot>     # 需要时整体回滚
```

交换目录为 `$DSH_HOME/memory/transfer/`（**默认**落点）：导入可用相对文件名直接引用它。指定位置时路径须为绝对路径（支持 `~`）、以 `.json` 结尾、位于家目录或 `/tmp` 之内，且**默认不覆盖已存在文件**（加 `--overwrite` 才覆盖）——这样"导出到任意位置"与"不越界写文件"可以兼得。导入同样接受这些允许目录内的绝对路径。

三条硬规则：

1. **导出单元是 `(索引条目, 会话记忆)` 原子对**——索引条目由选中的会话派生，不存在"只有索引、没有记忆"的包；
2. **导入以会话文件为准**：缺条目自动补建；包里出现无对应会话的条目则**拒绝并列入报告**，绝不制造孤儿；
3. **写前快照 + 契约校验**：写入 `memory-backup/import-<ts>/`（含 manifest），完成后校验"缺条目 0 / 孤儿 0"；同一 bundle 重复导入是幂等的。

导入已存在的会话时默认**合并**（视作一次保存追加进那条记忆，去重、超上限则拒绝并报告），可用 `--on-existing skip|replace` 改变；`--remap` 让导入的会话用新 id 并存、原 id 记入 `origin.originSessionId`。

### 数据位置

`$DSH_HOME/memory/`（通常 `~/.dsh/memory/`）：

| 路径 | 内容 |
|---|---|
| `profile.json` | 用户画像 |
| `global.json` | 全局索引（每会话一条） |
| `sessions/<sessionId>.json` | 各会话记忆（每会话一条） |
| `memory.db` | 派生 FTS5 索引，**不备份**，可随时重建 |
| `memory-backup/` | 自动备份、整理前快照、导入前快照（含 manifest，可回滚） |
| `transfer/` | 导出/导入交换目录（导出写、导入读） |

### 运行要求

- DSH（bundle 层挂载），Node ≥ 20；
- `node:sqlite`（Node ≥ 22.5）为**可选**：缺失或不可用时自动降级为 LIKE + JSON 子串检索，功能不受影响。

<details>
<summary>可选：源码热重载（DSH rc.2 起）</summary>

`@deepseek-ai/dsh-hmr` 支持插件源码热替换，但 base bundle 默认 `root: []`（只监视配置）。在自己的 profile patch 里指定模块根即可：

```yaml
- id: hmr
  disabled: false
  config:
    root:
      - ~/.dsh/memory-plugin   # 指向真实源码目录
    ignored: []                # 必须置空：默认 **/.* 会因路径含 .dsh 而误伤
```

改 `index.js` 后约 1 秒重挂，进程 pid 不变；语法错误不会炸进程（回滚并保留旧模块）。替换已安装包版本、或新增 `dsh.client` 声明仍需重启。

</details>

### 版本与变更

见 [Releases](https://github.com/kabarryo/dsh-structured-memory/releases)。

## 许可证

MIT（见 `LICENSE`，版权行 `Copyright (c) 2026 kabarryo`）
