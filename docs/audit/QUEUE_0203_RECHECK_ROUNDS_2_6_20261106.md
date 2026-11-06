# 第二轮队列 ②③ · 独立复核第 2~6 轮（归档）

日期：2026-11-06　｜　维护者：Project Director（实施方整理，结论均由非实施者出具）
依据：`docs/governance/CHARTER.md` §1「开发结论不构成验收结论」「独立只读子 Agent 不得修改被测代码」、§7「不得伪造 PASS」
范围：`576407f`（② 会话/导入/导出纯模块）与 `8091709`（③ `schemaVersion=2` 迁移链 + 备份）及其后续收敛改动
第 1 轮复审原文：`docs/audit/QUEUE_0203_CODE_INDEPENDENT_REVIEW_20261106.md`（结论 `PARTIAL`）
收敛代码提交：**`a13bf53`**（`fix(security): 收敛 ②③ 独立复审 P1/P2`）

> 本归档是**实施方对独立复核记录的结构化整理**：每轮的结论、发现、证据与判定均由独立只读子 Agent
> 出具，实施方未自审自签、未把 `PARTIAL` / `FAIL` 粉饰为 `PASS`。各轮完整逐条原文由子 Agent 在会话中
> 返回，可按下表 Agent ID 追溯；本文件不改动其结论，只做汇总与处置登记。
>
> 归档中出现的所有 `sk-*` / `TESTONLY-*` / `S2` 等均为复审者自造的**测试假值**，非真实凭证（宪章 §3.4）。

---

## 1. 复核者（均为独立上下文、只读、非实施者）

| 轮次 | Agent ID | 结论 |
|---|---|---|
| 第 1 轮（②③ 首审） | `agent-e2048b56-a622-4421-89bb-f70f7599652f` | `PARTIAL` |
| 第 2 轮 | `agent-a70dfb81-bbf1-4295-b999-3e80a9bc2c7a` | `PARTIAL` |
| 第 3 轮 | `agent-fd712594-16c5-4011-9558-d65b9f752344` | `PARTIAL` |
| 第 4 轮 | `agent-bb323f45-c167-4c54-83bc-754d95f87cf2` | `PARTIAL` |
| 第 5 轮 | `agent-417e2895-dc2b-40e9-90ed-997fbd051c50` | `PARTIAL` |
| **第 6 轮** | `agent-47b9a4d6-91e8-4bad-994f-bdcdb9c74796` | **`PASS`（代码级）** |

每轮均声明：未修改 / 新建 / 写入任何文件、未 `git commit / add / checkout / reset / clean`、未替实施方写修复代码；
变异检验一律用 esbuild `write:false` 内存替换或「临时改源码 → 同脚本恢复」；前后 `git status --short` /
`git diff --stat` / HEAD 逐项一致。

---

## 2. 六轮流转总表（为什么没有一次跳过）

| 轮 | 结论 | 该轮抓到的**真实**缺陷（可复现） | 实施方根因修复 | 再复核 |
|---|---|---|---|---|
| 1 | `PARTIAL` | P1-1 `buildAuditBundle` 对「实测报告整段丢失」全绿；P1-2 `buildSkillScanBundle` 对「扫描 body 置空」全绿（假 PASS）；P2 备份把含 `apiKey` 明文的整个原串复制进 `zxz.state.v1.backup.*`；5 条 P3 | 补断言 + 字符串级 `redactBackupRaw` | → 第 2 轮 |
| 2 | `PARTIAL` | **P2 真实绕过**：`"ap\u0069Key"` / `"\u0061piKey"` 经 `JSON.parse` 后键名就是 `apiKey`，会被读进 `settings.apiKey`，字符串级正则认不出 → 端到端备份含明文；MUT-C「报告被掏空成空壳」18/18 全绿；损坏 JSON 无闭合引号脱敏失效；`backup.raw` 仍是明文 | 两段式结构化脱敏 + 脱敏前移到 `decodeState` 的 `backupRequest` | → 第 3 轮 |
| 3 | `PARTIAL` | **新引入回归 N1**：递归 `walk` 在深嵌套（≥6000 层）爆 `RangeError`，`decodeState` 未捕获、`loadState` 静默吞掉 → 默认状态、历史不可见、不写备份；N2 非字符串 `apiKey` 值、N3 损坏 JSON + 转义键名、N4 `__proto__` 字段丢失、N5 MUT-C 冗余度仅 1 | 改用 `JSON.parse` 的 **reviver** + 线性 `looseRedact` 兜底；补 `整体不接` / `硬依赖 bun` 双锚点 | → 第 4 轮 |
| 4 | `PARTIAL` | **P2 组合绕过**：深嵌套（带 reviver 的 `JSON.parse` 约 2795 层起抛）退回字符串兜底时，`apiKey` 值为**对象/数组**（非字符串），正则只认 `"apiKey":"…"` → 明文残留 | 删除局部正则替换，改**二分策略**：合法 JSON 走 reviver 重建；任何结构化异常 → 含 `apiKey` 字样就返回**零原文安全摘要** `safeSummary` | → 第 5 轮 |
| 5 | `PARTIAL` | **P2 重复键绕过**：合法 JSON `{"apiKey":"S","apiKey":""}` 中 `JSON.parse` 只保留末值，reviver 只见空值 → `if (!hit) return raw` 把整个原串（含前一段 `"apiKey":"S"`）写进备份；8 组端到端复现，覆盖 v1/v3/corrupt 三条路径 | `hit` → **`sawApiKey`**：只要「见过 `apiKey` 键」就重建，重复键前值在 parse 阶段已丢弃；绝对断言改条件式 | → 第 6 轮 |
| **6** | **`PASS`** | 未找到任何合法 JSON 能让 **`apiKey` 字段明文**进备份键；无新增 P1/P2、无新引入回归 | — | **R15 / D-32 解除（代码级）** |

> 每一轮的 `PARTIAL` 都对应一个**可复现的实测缺陷**，不是「还有 P3 没修完」；五轮逐层剥掉的都是
> 「局部脱敏」这条思路的结构性缺口，最后收敛到「按解析结果二分，异常一律零原文」才闭环。

---

## 3. 第 6 轮终局证据（摘录）

| 项 | 实测 |
|---|---|
| 重复键关闭 | 13 变体 × 4 组 backup 路径 = **52 例端到端 `loadState()`**，全部 `ok`、会话保留、0 明文泄漏、备份键已写、不抛异常 |
| 主路径终局攻击 | **45 条合法 JSON + 7 条损坏 JSON**，含 Unicode 转义键名 / 大小写变体 / Kelvin sign / 嵌套任意层 / 数组 / `__proto__` / 值非字符串 / 重复键 / 深嵌套 catch 路径 → **`apiKey` 字段明文 0 泄漏** |
| 前 4 轮组合复验 | 深嵌套 **36 例**（6000/12000 层 × 字符串/对象/数组值 × 顶层/内层 × 字面/转义键名 × 对象/数组顶层）→ 0 泄漏、不抛异常、会话未被静默吞掉 |
| 逐字节与字段完整性 | 无 `apiKey` 键 / `{broken` / 单个 `apiKey:""` → `rawEq=true`、不引入占位；普通合法 v1 备份保留 `model` / `contextTurns` / `conversations[0].id` / `activeId`、`apiKey=[已脱敏]`、无摘要标记 |
| `decodeState` 4 条 backup 路径 | v1→`backup.v1`、v3→`backup.v3`、JSON 损坏→`backup.corrupt`、顶层非对象→`backup.corrupt`；`backup.raw` 均不含明文 |
| `safeSummary` | 输出恒为零原文（仅 `bytes` 长度 + 占位 + 原因），所有 `summary=true` 用例 `containsSecret=false` |
| 全量回归 | `npm test` **749 passed / 6 skipped（755 条，40 文件）**；`npx tsc --noEmit` exit 0；较基线 726 passed **+23**，等于新增 it 数（migration 13→29、state.persistence 5→11、exports 4→5） |
| P1 变异 | MUT-A 报告整段丢失 **7 条红** / MUT-B 扫描 body 置空 **4 条红** / MUT-C 空壳 **3 条红**；独立锚点 = `整体不接` + `硬依赖 bun`，**冗余度 2**（双向去一条仍各变红） |

第 6 轮同时确认：`migration.ts` 中「reviver 不会爆栈」的错误技术判断已修正为「约 2800 层起抛 `RangeError`，由 `try/catch` 收口」；
顶部注释 / JSDoc / `CLAUDE.md` 两处的绝对断言均已改为条件式；`hasApiKeyName` 注释改为「启发式」并登记漏判边界。

---

## 4. 实施方变异检验汇总（每轮修复后自验，非验收结论）

| 变异 | 预期 | 实测 |
|---|---|---|
| `buildAuditReportMarkdown()` → `""` | 红 | 2 条红（后续补强后 5~7 条红） |
| `scanSkill(..., s.body)` → `""` | 红 | 1~4 条红 |
| 报告掏空成「标题 + 字样」空壳（MUT-C） | 红 | 第 2 轮 **0 条红（坐实假 PASS）** → 补锚点后 1 条 → 双锚点后 **2 个 it 共 3 条红** |
| `redactBackupRaw` 恒等返回 / 备份绕过脱敏 | 红 | 4 + 2 条红 |
| 去掉结构化脱敏（Unicode 键名绕过重现） | 红 | 1 条红 |
| 损坏输入不解码 `\uXXXX`（N3 重现） | 红 | 1 条红 |
| reviver 判定退回「只看值非空」（重复键 P2 重现） | 红 | `migration.test.ts` 1 条 + `state.persistence.test.ts` 1 条红 |

所有变异均在同脚本内恢复，末尾 `RESTORED: True`；实施方**未把自验当验收结论**，每轮均重新提交给非实施者复核。

---

## 5. P3 遗留（如实仍在册，未被误标已修）

| # | 项 | 来源 |
|---|---|---|
| 1 | `normalizeImportedConversations` 畸形输入 6 处语义漂移（`content:0\|false`、`messages:[null]` 等） | 第 1 轮 #4 |
| 2 | 畸形 `schemaVersion`（`0` / `-1` / 字符串 `"3"`）语义冲突与备份键名 | 第 1 轮 #5 |
| 3 | 顶层未知字段不保留（`buildState` / `encodeState` 只投影三字段） | 第 1 轮 #6 |
| 4 | 备份写入失败静默吞掉且 `repairs` 仍声称「已备份」；`repairs` / `fromVersion` 无生产消费点 | 第 1 轮 #7 |
| 5 | 迁移规整测试盲区（`settings` 不做类型规整、`streaming:1`、非串 `compactSummary`） | 第 1 轮 #8 |
| 6 | `hasApiKeyName` 是**字样启发式**，极端畸形键名（拼接 `"ap" + "iKey"`、非法 hex `\u00ZZ`）在损坏 JSON 下可漏判 → 返回原串；此类输入 Key 不进 state，属留证边界 | 第 5 轮 |
| 7 | 非 `apiKey` 字段含相同字节（`api_key` / `api key` / `note` 回显 / 顶层原始值）会保留；为避免误改用户正文的**设计取舍** | 第 5 / 6 轮 |
| 8 | 备份键 `zxz.state.v1.backup.*` 只写不读、生产代码无清理逻辑（生命周期） | `CLAUDE.md` 已登记 |
| 9 | 极端深嵌套（带 reviver 的 `JSON.parse` 爆栈）的合法存档，备份降级为 `safeSummary` 零原文摘要、**不可人工恢复**（原始存档仍在主键 `zxz.state.v1`，未删数据） | 第 4 轮已登记取舍 |
| 10 | MUT-C′（空壳连结论字样也伪造）把锚点冗余度压到 1；超出 MUT-C 定义，INFORMATIONAL | 第 6 轮 |
| 11 | `CLAUDE.md` 安全红线一句措辞略宽于「无 apiKey 键时逐字节原样」，建议下批收口 | 第 6 轮 |

---

## 6. 未验证项（不冒充 PASS）

| 项 | 状态 |
|---|---|
| Windows + WebView2 真机 localStorage（配额 / 持久化 / 同源隔离 / 多窗口共享） | `BLOCKED` |
| 真机 CSP / DevTools 无报错（本轮未碰 `tauri.conf.json`） | `BLOCKED` / `NOT_TESTED` |
| 真实老用户升级路径（真 WebView2 从旧版裸 `zxz.state.v1` 完成迁移 + 备份） | `NOT_TESTED`（仅 jsdom 与内存 mock） |
| `npm run build` | **实施方实跑 PASS**（`749 passed / 6 skipped` 后，97 modules / 375.53 kB / gzip 135.54 kB）；复核子 Agent 受「禁止写文件」约束跳过并标 `NOT_TESTED`，改以 `tsc --noEmit` 覆盖类型层 |
| `src-tauri` 全量 Rust 编译 / 本地 e2e / 打包 | `NOT_TESTED` |
| 产品级 `READY_FOR_ACCEPTANCE` / 业主验收签字 | `ABSENT` |

---

## 7. 处置与决策记录

| # | 处置 | 证据 |
|---|---|---|
| D-32 / R15 | **解除（代码级）**：②③ 代码改动经非实施者独立复核，第 6 轮 `PASS` | 本文件 §1 / §3 |
| P1-1 / P1-2 | **已修**：导出装配契约补断言，MUT-A/B/C 精确变红 | `a13bf53` |
| P2 | **已修**：`redactBackupRaw` 按解析结果二分 + `backupRequest` 前移；六轮复核闭环 | `a13bf53` |
| P3-1 ~ P3-11 | **仍在册**（见 §5），未改、未误标 | 台账下批登记 |
| **DEC-023** | ②③ 独立复核由非实施者执行；`PARTIAL` / `FAIL` 一律如实登记，逐轮「复审 → 根因修复 → 再复审」直到 `PASS` 才解除 R15 | 宪章 §1 / §7；沿用 DEC-019 口径 |
| **DEC-024** | 备份脱敏定为二分策略：**合法 JSON → reviver 按解析后真实键名重建；任何结构化异常 → 零原文安全摘要**。畸形深嵌套存档的备份降级为摘要，原始存档仍在主键、不删数据 | 第 4~6 轮实测 |
| **DEC-025** | 畸形输入类 P3 如实登记、**不在本轮修**，避免把「关掉 R15」扩大成全仓重构（不冒进 / 一次提交只做一件事） | 宪章 §5.1；DEC-015 / DEC-020 |

> **判定边界**：本结论仅为**代码级** `PASS`，不等于产品验收签字；`npm run build` 由实施方实跑，
> 复核子 Agent 的 `NOT_TESTED` 标注如实保留，未合并成一个笼统的 PASS。
