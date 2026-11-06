# 第二轮队列 ②③ 代码改动 · 独立复审意见（归档原文）

日期：2026-11-06　｜　复审者：**QA / Code Reviewer 独立只读子 Agent**（非实施者，独立上下文，Agent ID `agent-e2048b56-a622-4421-89bb-f70f7599652f`）
依据：`docs/governance/CHARTER.md` §1「开发结论不构成验收结论」「独立只读子 Agent 不得修改被测代码」
范围：`git show 576407f`（② 会话/导入/导出纯模块）与 `git show 8091709`（③ `schemaVersion=2` 迁移链 + 备份）两笔提交的完整 diff；当前 HEAD `336b115`（其后两笔为纯文档同步，不在范围）
复审方式：取得完整 diff 后逐个核查源码与对应单测，5 次**内存变异检验**（esbuild `write:false`，不落盘）；**未修改任何文件、未提交、工作区前后均干净**。

> 本意见是独立复核记录，**不是业主验收签字**。产品级 `READY_FOR_ACCEPTANCE` 仍需业主确认。
> 复审原文中出现的 `sk-LIVE-0001` 等字符串均为复审者自行构造的**测试假值**，非真实凭证（宪章 §3.4）。

---

## 复审结论

**PARTIAL** —— 核心搬运与迁移链经逐行对照 + 2 次精确变红变异验证为正确（独立基线 `726 passed / 6 skipped`、`tsc --noEmit` exit 0），但 ② 的导出装配测试对「实测报告 / 扫描输入丢失」全绿、会产生假 PASS（P1），迁移备份把 `apiKey` 明文复制进多个无清理的 localStorage 键、扩大安全驻留面（P2），并有若干畸形输入语义漂移与测试盲区（P3），不足以标 PASS。

已独立核对通过、不构成发现的项（按宪章 §1 由非实施者复核后方成立）：① `addConversation` / `switchActive` / `renameConversationIn` / `removeConversation` / `clearMessagesIn` / `buildAuditBundle` / `buildSkillScanBundle` 与 `576407f` 删除的内联代码逐行等价，App.tsx 调用点（`src/App.tsx:205,217,232,245,258,967-970,986,1033-1035`）参数与返回值一一对应；② `state.ts` 全部读写走 `decodeState`/`encodeState`，全局 grep 仅 `src/state.ts:21,26,38` 三处 localStorage、无遗漏直读；③ 迁移链对旧版 / 未来版本 / 损坏 JSON / `null`·数组·字符串·数字根 / 失败回落 / 未知字段（settings·会话·消息三层）行为正确，v2 不再重复备份（`state.persistence.test.ts` 5 例）；④ 三个新模块及其依赖链不 import react、`src/orchestration/` 无反向引用、两笔 diff 未触及 `package.json`（无新增依赖，宪章 §3.3）。

## 发现（分级，每条带 文件:行号 或 可复现命令）

| # | 级别 | 描述 | 证据 | 可复现? |
|---|---|---|---|---|
| 1 | P1 | `exports.test.ts` 两个 `buildAuditBundle` 用例对「实测报告整段丢失」全绿；`buildAuditBundle` 存在的唯一理由（清单 + 实测报告合成一份，见 `exports.ts:14` 注释与 `App.tsx:961-964`）无任何断言验证报告存在，回归时测试不会红 → 假 PASS | `src/lib/exports.ts:15-23`、`src/lib/exports.test.ts:14-24`；变异 4：把 `buildAuditReportMarkdown(),` 换成 `"",` 后两用例 6 个断言全 PASS，探针 `md.includes("技能来源实测审计报告")` FAIL | 是（变异检验 4） |
| 2 | P1 | `buildSkillScanBundle` 两用例对「扫描输入 body 丢失」全绿：断言锚点全来自 `buildScanMarkdown` 固定模板，`not.toContain(正文标记)` 实际测的是 `scanSkill` 而非 bundle 装配 | `src/lib/exports.ts:26-31`、`src/lib/exports.test.ts:26-41`；变异 5：`scanSkill(s.id,s.name,s.body)`→`scanSkill(s.id,s.name,"")` 后两用例全 PASS，探针「递归删除」命中 FAIL | 是（变异检验 5） |
| 3 | P2 | 迁移前备份把**含 `apiKey` 明文的整个存档原串**复制进 `zxz.state.v1.backup.*` 多个键；这些键只写不读、生产代码无任何清理逻辑，扩大密钥本机驻留面，与 `CLAUDE.md:71-72`「API Key 只存键 `zxz.state.v1`」的单键表述不一致。**未发现外发/进入导出物**：会话导出只序列化 `conversations`（`App.tsx:1016`）、`persistMarkdown` 只写 md（`App.tsx:945`）、两个 bundle 参数不含 state、备份键无读取点——风险性质是「驻留面扩大 + 生命周期失控」，非已外泄 | `src/state.ts:24-29`、`src/lib/migration.ts:124,151,163-166`；实证 A/A2：旧版裸存档含 `sk-LIVE-0001`，`loadState()` 后 `zxz.state.v1.backup.v1` 值含该明文、`backup.raw === 原始 raw`；全项目 grep `removeItem\|clear` 仅命中测试文件 | 是（实证 A2 + grep） |
| 4 | P3 | `normalizeImportedConversations` 合法输入等价，但畸形输入有 6 处语义漂移 + 异常路径变化，且新增测试未锁（变异 3 证明 `content:42` 用例对 `\|\|`→`??` 不敏感）：`messages:[null]` 旧抛 `TypeError`→整文件走 catch「导入失败」（`App.tsx:1037-1039`）/ 新产出一条空 user 消息并成功导入；`content:0\|false` 旧 `""` / 新 `"0"\|"false"`；`reasoning` 非串、`createdAt` 非数或为 0、`title` 非串 truthy 均被收紧；时间戳由多次 `Date.now()` 变单一 `now` 参数（为可测性引入）。方向多为更健壮，未发现合法输入回归，但严格「搬运等价」不成立，且未按宪章 §5.2 同步加测试 | `576407f` diff 的 App.tsx 删除行 vs `src/lib/conversations.ts:45-70`；实证 D 对照表（`title` 非串 truthy 一条为代码级对照，未单独跑） | 是（实证 D + 变异 3） |
| 5 | P3 | `decodeState` 对畸形 `schemaVersion` 语义冲突 / 键名畸形：`0`→`fromVersion=0`（与 `DecodeResult` 注释「0=无存档」冲突）却有 v1 备份、reason 文案写「迁移 v0→v2」；`-1`→备份键 `...backup.v-1`；字符串 `"3"` 降级为 v1 备份（未来版本被误标 v1）。正常存档（无字段 / 2 / >2 / 2.9）行为正确 | `src/lib/migration.ts:30-31,137-155`；实证 C 边界扫描 | 是（实证 C） |
| 6 | P3 | 「不丢未知字段」仅覆盖 settings / 会话 / 消息三层，**顶层未知字段不保留**：`buildState` 只投影三字段、`encodeState` 写回亦只含三字段；与 `migration.ts:8` 注释按顶层理解时不符（v3 有原始备份兜底，不丢数据但会降版）。`migration.test.ts:78-88` 未覆盖顶层 | `src/lib/migration.ts:94-109,164-166`；实证 C：`topFuture:"KEEP"` 读回 `undefined` | 是（实证 C） |
| 7 | P3 | 备份写入失败被静默吞掉且 `repairs` 仍声称「已备份」；`repairs`/`fromVersion` 在生产代码中**无任何消费点**（仅测试断言），当前不外显，一旦接入诊断面板即成控制面失真 | `src/state.ts:25-29`（空 catch）、`src/lib/migration.ts:148,155`；grep `repairs\|fromVersion` 除 migration.ts / 测试外无命中 | 是（grep + 读代码） |
| 8 | P3 | 迁移规整的测试盲区：`settings` 只做默认值合并不做类型规整（畸形 `contextTurns`/`apiKey`/`theme` 原样入 state）；仅 `streaming === true` 复位、`streaming:1` 不复位；非字符串 `compactSummary` 经 `...(src as Conversation)` 原样保留。`migration.test.ts` 均未覆盖 | `src/lib/migration.ts:51-60,83-96` | 否（仅静态对照，未单独跑变异） |

## 变异检验记录

方法：`node` 内用 `esbuild.build`（异步、`write:false`、`onLoad` 拦截源文本做字符串替换）在**内存**中编译目标模块并变异，`new Function` 执行 bundle，断言逐条复制自对应 `.test.ts`；全程不落盘、不改源、不碰 git。5 次结果：

1. **`migration.ts` 去掉未来版本备份分支**（`if (declared > STATE_SCHEMA_VERSION) {`→`if (false) {`）：原始 `migration.test.ts`「未来版本 v3」用例 PASS，变异后 FAIL（`backup` 实得 `null`）——**精确变红**，证明该用例真测到备份行为。
2. **`conversations.ts` `removeConversation` 不回落 activeId**：原始「删除当前会话回落第一条」PASS，变异后 FAIL（实得 `a`）——**精确变红**，证明该用例真测到回落分支。
3. **`conversations.ts` `String(src.content ?? "")`→`String(src.content \|\| "")`（回退旧 App 逻辑）**：测试原文 `content:42` 断言原始绿、**变异仍绿（不红）** → 证明该用例对 `??` 分支不敏感；加探针 `content:0` 期望 `"0"`，原始绿、变异 FAIL（实得 `""`）→ 证明语义漂移真实存在而测试未覆盖。
4. **`exports.ts` 丢掉实测报告**（`buildAuditReportMarkdown(),`→`"",`）：`exports.test.ts` 两个 `buildAuditBundle` 用例共 6 个断言原始全绿、**变异全绿（不红）** → 坐实 P1 假 PASS；探针 `md.includes("技能来源实测审计报告")` 原始绿、变异 FAIL。
5. **`exports.ts` 扫描输入 body 置空**：`buildSkillScanBundle` 两用例断言原始全绿、**变异全绿（不红）** → 坐实 P1；探针「`rm -rf` 命中递归删除」原始绿、变异 FAIL。

即 2 次「精确变红」（验证有效用例），3 次「精确不变红」（验证假 PASS / 盲区），均达到预期，无一次变异误报。

## 未验证项

- **BLOCKED**：Windows + WebView2 真机 localStorage 行为（配额上限、持久化、同源隔离、多窗口共享）；备份写入失败（配额满 / `SecurityError`）仅在代码级确认吞错，**未在真机或 jsdom 注入失败**验证。
- **BLOCKED**：真机 CSP / DevTools 无报错（沿用上一轮结论；本轮未碰 `tauri.conf.json`，宪章 §3.7）。
- **NOT_TESTED**：真实老用户升级路径（真 WebView2 里从旧版裸 `zxz.state.v1` 启动并完成迁移 + 备份），仅 jsdom 模拟（`state.persistence.test.ts`）与 `node` 内存实证。
- **NOT_TESTED**：`src-tauri` 全量编译、本地 e2e、打包；本轮为纯前端 TS 变更，未跑 Rust / 宿主。
- **NOT_TESTED**：`npm run build`（`tsc && vite build`）会产出 `dist/`，与「禁止写任何文件」约束冲突，故未跑；改以只读 `npx tsc --noEmit`（exit 0）覆盖类型层，`AuditSkillRow` 与调用点参数类型已通过。
- **NOT_TESTED**：`apiKey` 是否会被「将来新增的 localStorage 诊断/导出功能」连带带出——当前无此功能，属潜在风险而非已发生外泄。

## 复审范围声明

**读过的文件**：`docs/governance/CHARTER.md`（全文，重点 §1/§3/§7）、`CLAUDE.md`（全文，含架构边界与安全红线）；`git show 576407f`、`git show 8091709` 完整 diff 及两笔 `--stat`；`git log -5 --oneline`；当前 `src/App.tsx`（85-170 / 190-270 / 918-958 / 955-1070 区段 + `commit`/`update`/`persist` grep）、`src/lib/conversations.ts`、`src/lib/exports.ts`、`src/lib/migration.ts`、`src/state.ts`（全文）；4 个新增测试 `conversations.test.ts`/`exports.test.ts`/`migration.test.ts`/`state.persistence.test.ts`（diff 内全文）；依赖链 `src/lib/text.ts`、`src/presets.ts`、`src/types.ts`、`src/skills/sources.ts`（`buildAuditMarkdown`）、`src/skills/audit.ts`（`buildAuditReportMarkdown`）、`src/lib/skillscan.ts`（`buildScanMarkdown`/`scanSkill`）、`src/lib/skill.ts` 头部；`package.json`（`node -e` 读 deps/scripts）。

**跑过的命令（均只读）**：`git log/status/rev-parse/show/show --stat`；`npm test`（`726 passed / 6 skipped (40 files)`，与 `CLAUDE.md:120` 基线一致）；`npx tsc --noEmit`（exit 0）；多组 `grep`（localStorage 全局、`STORE_KEY`/`backup.`、`repairs|fromVersion|decodeState|encodeState` 消费点、`react` in `src/lib`/`src/orchestration`、`removeItem|clear` 清理逻辑）；5 次 `node <<'NODE'` 内存变异 harness（esbuild `write:false`）；`node <<'NODE'` 实证 A（apiKey 入 backup.raw）/ A2（端到端 `loadState` 备份键含明文）/ C（15 例迁移边界扫描）/ D（11 例旧内联 vs 新纯函数对照）；前后多次 `git status --porcelain`（均 0 行）。

**没做的事**：未修改任何被测代码、未新建/写入任何文件（含临时文件）、未 `git commit / checkout / reset / add`、未 `git clean`；未替实施方写修复代码；未复核 `336b115`、`e40c03f`（纯文档同步）与 `2761391`（①′ 已三轮复核 PASS，且不在本轮 R15/D-32 范围）。最终工作区干净、HEAD 仍 `336b115f9b39b04c2a6d6ac7a85515a4c8b580e0`。

---

## 归档后处置（实施方填写，非复审者结论）

| # | 处置 | 提交 / 证据 |
|---|---|---|
| P1-1 / P1-2（假 PASS） | **已修**：`exports.test.ts` 补实测报告标题 / 顺序 / `整体不接` / `硬依赖 bun` 与扫描 body 命中断言；MUT-A/B/C 三次变异均精确变红，MUT-C 冗余度 2 | `a13bf53`；`QUEUE_0203_RECHECK_ROUNDS_2_6_20261106.md` §4 |
| P2（备份含 `apiKey` 明文） | **已修**：`redactBackupRaw` 按解析结果二分（reviver 按真实键名重建 / 异常零原文摘要），`backupRequest` 前移使 `BackupRequest.raw` 产出即脱敏；六轮复核第 6 轮 `PASS` | `a13bf53`；同上 §2 / §3 |
| P3-1 ~ P3-5 | **如实仍在册、未改**：见复核归档 §5（另新增 6 条历轮 P3） | 台账下批登记 |
| 再复核结论 | 第 2~5 轮均 `PARTIAL`（逐轮抓到可复现的真实绕过），**第 6 轮 `PASS`（代码级）** → R15 / D-32 解除 | `QUEUE_0203_RECHECK_ROUNDS_2_6_20261106.md` |
