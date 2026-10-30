# tests/

2026-10-21 目录迁移时发现：此前维护的十二套回归测试（约 289 项断言）只存在于 `/tmp`，随系统清理丢失。

2026-10-23 起，本目录以最小脚手架重建（**不是**原 289 断言的替代品）：

- `lib/register.mjs` —— 用 `module.registerHooks` 把 `@deepseek-ai/schemastery` / `dsh-tools` / `dsh-llm` 映射到 `lib/stubs/`，因此 `index.js` 能在 DSH 之外被纯 node import；
- `lib/harness.mjs` —— `test` / `assert` / `assertEqual` / `tempStore` / `memoryTools` / `fakeAgent`；`memoryTools` 用假 `ctx.tools.register` 实例化插件真实工具，因此测试可以像模型一样调用 `execute()`；
- `run.mjs` —— 导入全部 `*.test.mjs`，串行执行，10s 超时，失败退出码非 0。

约定：

- 测试放在本目录，随源码一起保存，**不再放 `/tmp`**；
- 每条用例用 `tempStore()` 建临时记忆根（`memoryDir`），**不碰真库** `~/.dsh/memory`；
- 宁可断言「坏实现会失败」的东西（按文件路径召回、秘密不落盘、丢锚点被拒、旧索引自愈），不要只断言「没抛异常」。

当前覆盖（109 条，`npm test` 单入口）：

| 文件 | 覆盖 |
|---|---|
| `injection.test.mjs` | 注入契约：画像在索引之前、**当前会话永不注入**、每条索引始终列出、`injectLimit` 只影响要点、字节预算逐级降级、索引永不被静默丢弃、profile 块始终闭合、`order:130` 注册一次、mtime 缓存与损坏文件降级 |
| `corrections.test.mjs` | 记忆纠正：定点删除旧行后追加新事实、多片段、规范化匹配、未命中拒绝且不落盘、`supersedes` 必填、`sessionId` 仅限纠正、跨会话纠正同步条条目与索引、子 agent 拒绝、快照与审计日志、16k 超限整体拒绝、`<private>` 剔除 |
| `single-memory.test.mjs` | 单条制：16,000 字符上限（拒绝而非截断）、id/createdAt 稳定、mergedCount、重复保存字节不变、旧多条目折叠、global 条目唯一、keyPoint 50/100 上限与指针剥离、trigger/evidence 协议、子 agent 只读、forget 三处同步、files 上限 |
| `bridge.test.mjs` | 会话桥：loopback、编辑器视图、`profile.replace` 去重/超限、`global.update` 写穿、`global.remove` 仅限孤儿、`memory.replace` 保留 id/createdAt/files 并重建索引、`memory.remove`、`session.remove`、`session.collapse` 幂等、`config.set` 白名单与 settings 服务、`doctor.repair`、未知 op、超大 body |
| `transfer.test.mjs` | 导出导入：checksum 篡改检测、confirm 强制、空库导入、merge/skip/replace/remap 四种模式、血缘、rollback、路径限制、覆盖保护、范围收窄、导入时 `<private>` 再脱敏 |
| `files.test.mjs` | `files` 归一化/并集、save→recall 按路径召回、bundle 往返、`/dream` 保留 files |
| `search-index.test.mjs` | 旧索引自愈迁移、files 检索、短查询 LIKE 回退 |
| `skill.test.mjs` | skill 元数据、注册/降级/重复注册、描述预算与占位符回归 |
| `categories.test.mjs` | 五值枚举与别名、`/dream` 类型优先级、安全锚点硬闸、导出不改写 |
| `private.test.mjs` | `<private>` 切除、四条写入路径、全私密拒存 |
| `timeline.test.mjs` | 窗口取整、锚点缺失、孤儿会话、`scope=timeline` 路由 |
| `contracts.test.mjs` | 模块可加载、单条制合并 |

**P0 状态**：注入契约、单条制、会话桥、导出导入四套已完成，并逐套做过「改坏实现 → 测试变红」的变异验证。剩 jsdom 数据页交互（需要 devDependency，暂缓）。
