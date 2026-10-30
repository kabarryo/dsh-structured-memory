> **本插件全程由 DeepSeek Harness（DSH）+ DeepSeek V4.1 Flash 开发与维护：100% 纯 AI 生成，人工代码 0 添加。**

# dsh-structured-memory

DSH 的跨会话记忆插件。把会话里定下来的结论沉淀成可读的 JSON 文件，下次会话自动回到上下文；需要细节时再按需检索。

## 特性

- **画像 + 索引常驻，正文按需**：用户画像与全局索引（每会话一条摘要）由 DSH 运行时上下文注入，内容没变就不重复注入；会话正文不常驻，用 `recall_memory` 取。
- **每会话一条结论**：保存是改写这一条而不是堆积，自动去重合并，单条上限 16,000 字符。
- **可以纠正**：`trigger: 'correction'` + `supersedes` 删掉过期或记错的旧行，再写入新事实；可纠正**过去会话**的记忆。
- **全文检索**：FTS5（trigram，适配中文）覆盖正文与文件路径；`node:sqlite` 不可用时自动降级为子串扫描，功能不断。
- **文件坐标**：每条记忆可带 `files: [{path, action: 'read'|'modified'}]`，回答「这个文件以前被谁改过」。
- **人工可编辑**：插件页六个页签（用户画像 / 全局索引 / 注入控制 / 整理 / 会话记忆 / 数据），JSON 是唯一事实源，改完即生效。
- **可整理**：`/dream` 或页面按钮，后台调用一次模型生成压缩建议稿，人工确认后应用，写前自动快照。
- **隐私标记**：`<private>…</private>` 的内容留在对话里，入库前剔除。
- **本地优先**：零运行时依赖、无账户、无常驻进程；数据是可 diff、可 git、可直接手改的 JSON。

## 安装

**推荐让 agent 装。** 把下面这段原样发给你的 DSH agent：

```text
在本机安装 DSH 插件 dsh-structured-memory。
1. 取源码：git clone https://github.com/kabarryo/dsh-structured-memory ~/dsh-structured-memory
2. 在目标 profile 的 package.json（默认 ~/.dsh/profiles/web/package.json）里：
   - dependencies 增加 "dsh-structured-memory": "link:/Users/<你>/dsh-structured-memory"
   - dsh.profile.bundles 数组里，紧跟 "@deepseek-ai/dsh-web-app" 之后加入 "dsh-structured-memory"
3. 在该 profile 目录执行 pnpm install。
4. 重启 DSH。
5. 验证：工具列表出现 save_memory / recall_memory；插件页出现本插件行；
   让会话保存一条记忆后，下一步上下文出现 <user_profile> 与 <global_memory_index>。
```

手动安装就是上面五步。两个常见坑：

- **只写 patch 不注册 bundle**：在 `cordis.patch.yml` 里写 `- id: dsh-structured-memory` 会被当作「覆盖一个不存在的条目」直接丢弃。要么把它加进 `dsh.profile.bundles`，要么在 patch 里写成完整的 `- insert:` 块。
- **改过插件目录名**：profile 的 `node_modules` 里 `link:` 软链不会自动更新，表现为插件静默不加载；重装或手动重建软链即可。

## 使用

### 工具

| 工具 | 用途 |
|---|---|
| `save_memory` | 保存本次会话的结论（写入当前会话的唯一记忆，并维护全局索引） |
| `recall_memory` | 按关键词 / 分类 / 范围检索；`scope` 支持 `profile` `global` `session` `all` `timeline` |
| `load_session_memory` | 把某个历史会话的完整记忆一次性载入当前对话 |
| `forget_memory` | 删除一条记忆或整个会话（同步清理索引） |

`save_memory` 只在事件确实发生时才该调用：用户要求记住、用户验收了交付物、定下无法从仓库反推的取舍、纠正既有记忆。后三者需要带证据（用户原话，或路径/命令/哈希/数字）。

子 agent 只读：可以 `recall_memory` / `load_session_memory`，不能保存或删除。

### 纠正旧记忆

新事实不再覆盖旧说法，而是显式替换：

```text
save_memory({
  trigger: 'correction',
  supersedes: ['部署端口是 8080'],      // 旧片段，命中整行删除（忽略大小写/空格/标点）
  content: '部署端口是 3000',
  evidence: '用户：端口已改为 3000',
  sessionId: 'session-xxxx'            // 可选，纠正过去会话
})
```

一条都对不上会被拒绝，而不是模糊替换——先用 `recall_memory` 取原文。纠正前会快照到 `memory-backup/corrections/`。

### 插件页

侧栏 **插件 → dsh-structured-memory → 配置**：

- **用户画像 / 全局索引**：直接编辑注入内容。
- **注入控制**：调索引条数与字节预算，并按区块估算 token。
- **会话记忆**：浏览、删除、重写某个会话的记忆；「整理该会话」把它压缩成一条。
- **整理**：压缩画像与索引，生成建议稿后确认应用。
- **数据**：导出 / 导入带校验和的 JSON bundle，可预览、可回滚。

### 对话命令

| 命令 | 作用 |
|---|---|
| `/dream` | 生成整理建议稿 |
| `/dream apply` | 应用建议稿（先快照） |
| `/dream discard` | 丢弃建议稿 |
| `/dream status` | 查看整理模型与最近几次结果 |

整理模型需要在插件页「整理」页签里自行选择并保存，插件不会替你挑模型。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖，或直接改插件页可写字段。

| 项 | 默认 | 说明 |
|---|---|---|
| `injectLimit` | 20 | 带要点的索引条数（所有条目的标题始终注入） |
| `maxInjectBytes` | 8192 | 注入字节预算，超限逐级裁剪 |
| `maxProfilePoints` | 100 | 画像每个区块的要点上限 |
| `maxMemoriesPerSession` | 1000 | 单会话记忆条数上限 |
| `autoBackupMin` | 1440 | 自动备份间隔（分钟），`<=0` 关闭 |
| `backupRetainDays` | 7 | 备份保留天数 |
| `migration` | true | 首次启动迁移旧版 `memories.json` |
| `subagentMemoryReadOnly` | true | 子 agent 记忆只读 |
| `saveRequireEvidence` | true | 非用户明确要求的保存必须带证据 |

## 数据

默认在 `$DSH_HOME/memory/`（通常是 `~/.dsh/memory`）：

- `profile.json`、`global.json`、`sessions/<sessionId>.json` —— 唯一事实源
- `memory.db` —— 可重建的 FTS5 派生索引
- `memory-backup/` —— 自动备份、整理与纠正前的快照
- `corrections-log.json`、`consolidation-log.json` —— 纠正与整理审计

## 要求

Node ≥ 20。`node:sqlite`（Node ≥ 22.5）可选，缺失时自动降级。测试：`npm test`（Node ≥ 22.15）。

## 许可

MIT。版权行见 `LICENSE`。
