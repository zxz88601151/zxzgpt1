# 外部仓库拉取 + 技能热插拔评估（10 个候选仓库）

> 日期：2026-11-02
> 性质：**AUDIT-ONLY**。本轮只拉取、只读、只评估，未修改任何业务代码、未改 `src/skills/sources.ts`。
> 快照位置：`F:/zhuomian/zxz/.refs/src/<owner>__<repo>/`（拉取脚本 `.refs/_fetch.sh`、`_fetch2.sh`，日志 `_fetch.log`、`_fetch2.log`）
> 状态口径：`PASS` 实测通过 / `FAIL` 实测不通过 / `BLOCKED` 环境阻断 / `NOT PRESENT` 未拿到，不做推断。

---

## 0. TL;DR

| 结论 | 内容 |
|---|---|
| 能直接插（零改写） | **0 个**。没有一份第三方 `SKILL.md` 同时满足「目录布局合规 + 正文 ≤ 12000 字符 + 有 `triggers`」 |
| 改一层就能插（补 frontmatter + 指向子目录） | `microsoft/agent-framework`（2 份，8260 / 7047 字符，唯二不超限） |
| 必须重写才能插（体积腰斩 / 布局不合规） | `ui-ux-pro-max`（7 技能，2 份超限 + 13 份同名副本）、`taste-skill`（39537 字符 = 3.3 倍上限）、`addyosmani/agent-skills`（15/25 超限） |
| 不是技能，是运行时能力（插技能库无用） | `playwright-mcp`（72 个 `browser_*` 工具，走 MCP）、`modelcontextprotocol/servers`（协议与沙箱样板）、`browser-use`（Python 库） |
| 只能抄设计，不能装 | `MiMo-Code`（hardPermission 写法可抄）、`agent-framework`（编排 + 渐进暴露）、`tauri`（插件清单，**本次未拉全**）、`playwright`（**未拉到**） |

一句话：**这 10 个仓库没有一个能"热插拔"，但其中 7 个有明确的落地路径**——分属「重写成技能」「接成 MCP 工具」「抄进权限模型」三条不同路线，不能混为一谈。

---

## 1. 拉取通道实测（先说基建，它决定了后面能验到什么）

| 通道 | 结果 | 证据 |
|---|---|---|
| `git clone https://github.com/...` | **FAIL** | `CONNECT tunnel failed, response 502`（本机代理 `127.0.0.1:50398` 不给 CONNECT 隧道） |
| `https://github.com` 裸连 | **FAIL** | `curl` 超时，code 000 |
| `https://codeload.github.com/<repo>/tar.gz/refs/heads/<br>` | **PASS（间歇）** | 10 个仓库中 8 个拿到内容；大文件传输会中途停住，停住后不再增长 |
| `raw.githubusercontent.com` / `cdn.jsdelivr.net` / `fastly.jsdelivr.net` / `raw.githack.com` | **FAIL** | 均 000 / 301 后断开 |
| `https://data.jsdelivr.com/v1/packages/gh/...?structure=flat` | **PASS** | 能拿完整文件树 + 每个文件大小（`ui-ux` 411 文件、`tauri@dev` 1061 文件） |
| `gh-proxy.com` 镜像 | 部分 PASS | 同样在 4.8MB 处停住，不比直连可靠 |

### 落地清单

| 仓库 | 分支 | 结果 | 快照大小 |
|---|---|---|---|
| `addyosmani/agent-skills` | main | **PASS** | 1.7M（tarball 380KB） |
| `Leonxlnx/taste-skill` | main | **PASS** | 3.2M（tarball 1.35MB） |
| `modelcontextprotocol/servers` | main | **PASS** | 5.0M（tarball 1.2MB） |
| `microsoft/playwright-mcp` | main | **PASS** | 365K（tarball 79KB，仓库是构建产物快照） |
| `browser-use/browser-use` | main | **PASS** | 11M（tarball 4.88MB） |
| `microsoft/agent-framework` | main | **PASS** | 75M（tarball 17MB） |
| `XiaomiMiMo/MiMo-Code` | main | **PASS** | 28M（tarball 8.8MB） |
| `nextlevelbuilder/ui-ux-pro-max-skill` | main | **PARTIAL** | 17M（tarball 截断：直连停在 5398528、镜像停在 4861952、重试停在 1671168，`gzip -t` 报 unexpected EOF；已尽力提取出 13 份 `SKILL.md` 与 `data/*.csv`） |
| `microsoft/playwright` | — | **BLOCKED** | 下载未完成时通道中断，目录不存在 |
| `tauri-apps/tauri` | main/master 404 | **BLOCKED** | 两个分支均 404（真实默认分支是 `dev`）；`dev` 分支下载停在 1.1MB |

**两个必须留痕的坑：**

1. **`tauri` 的默认分支不是 main/master**，是 `dev`。按 main/master 探测会得到 404，容易误判成"仓库不存在"。
2. **元数据接口与真实仓库会不一致**：`data.jsdelivr.com` 拿到的 `ui-ux-pro-max` 快照只有 1 个技能（`ui-ux-pro-max`，13 份平台副本），而 codeload 当前 main 实拉出 **7 个技能**（`banner-design` / `brand` / `design` / `design-system` / `slides` / `ui-styling` / `ui-ux-pro-max`）。**以实拉的为准，缓存快照只能当线索。**

---

## 2. 项目侧硬约束（热插拔的判定尺，全部来自真实代码）

| 约束 | 值 | 位置 |
|---|---|---|
| 单份正文上限 | `MAX_SKILL_BODY = 12000` 字符，超出截断并追加提示 | `src/lib/skill.ts:77`、`:272` |
| 同时启用上限 | `MAX_ACTIVE_SKILLS = 3` | `src/lib/skill.ts:75` |
| 自动匹配上限 | `MAX_AUTO_MATCH = 2` | `src/lib/skill.ts:81` |
| 单次 `@@ref` 上限 | `MAX_SKILL_REFS = 4` | `src/lib/skill.ts:79`、`:349` |
| 扫描候选上限 | `MAX_SCAN = 200` | `src/lib/skillstore.ts:16` |
| 单文件读取上限 | `MAX_SKILL_FILE = 200_000` 字符 | `src/lib/skillstore.ts:18` |
| 目录布局 | 仅两种：`<库>/<id>/SKILL.md`、`<库>/skills/<id>/SKILL.md` | `src/lib/skillstore.ts:4-5`、`:47`、`:53` |
| frontmatter 必填 | `description` 缺失即判无效；`triggers` 支持 `triggers` / `keywords` / `when` 三种别名 | `src/lib/skill.ts:215`、`:218` |
| 无 `category`/`stage` | 归「未分类 / other」，不猜 | `src/lib/skill.ts:220-222` |

> 判定尺的意义：`description` 是唯一硬门槛，`triggers` 是"能不能被一句话自动命中"的关键——**第三方技能 100% 没有 `triggers`**，所以"热插"之后它们只能靠手动勾选，自动匹配这条路径对所有第三方技能都是失效的。

---

## 3. 逐个评估

### 3.1 `nextlevelbuilder/ui-ux-pro-max-skill` — 设计智库（UI 缺口）

| 维度 | 实测 | 判定 |
|---|---|---|
| 形态 | `.claude/skills/<id>/SKILL.md` + `<id>/data/*.csv`；同一技能在 6 个平台目录（`.claude` `.codex` `.continue` `.gemini` `.opencode` `.trae`）各存一份，根目录与 `cli/assets` 再各存一份 | **FAIL**：不符合两种布局 |
| 技能数 | 实拉 7 个（快照 API 只显示 1 个，见 §1 坑 2） | — |
| 体积 | `ui-ux-pro-max` 15969、`design` 14196 超限；`ui-styling` 10945、`design-system` 7458、`banner-design` 7071、`brand` 3926、`slides` 1720 合规 | 2/7 超限 |
| 元数据 | frontmatter 只有 `name` + `description`，无 `triggers` | 需补 |
| 知识库规模（实测行数） | `styles.csv` 89、`colors.csv` 193、`typography.csv` 75、`ux-guidelines.csv` 120、`icons.csv` 106、`charts.csv` 26、`landing.csv` 35、`motion.csv` 18、`products.csv` 193、`ui-reasoning.csv` 193、`app-interface.csv` 33、`react-performance.csv` 45 | — |
| 重量级附件 | `google-fonts.csv` 747KB / 1935 行、`phosphor-icons-upstream.json` 823KB、`google-font-licenses.json` 433KB、`data-provenance.json` 36KB | **绝不能进提示词** |

**关键修正**：正文自称 "79 searchable styles (50 active), **192** product palettes, **74** font pairings, 119 UX guidelines, 105 icons, 17 GSAP presets, 25 chart types, **22 stacks**" —— 与"50 风格 / 161 配色 / 57 字体"的旧说法不同，**以实测为准**（版本在往前走）。

**结论：可接入，但必须重写。** 三条硬动作：
1. 去重：13 份同名副本只留 1 份（否则同名 id 互相覆盖，且一个技能占掉 `MAX_ACTIVE_SKILLS=3` 的三个坑）；
2. 重排：`.claude/skills/*` → `skills/*`，让它落进布局 B；
3. 瘦身：15969 → ≤12000，把规则明细拆到 `references/`，CSV 只留"按需查表"入口（见 §4.3）。

### 3.2 `Leonxlnx/taste-skill` — 反 AI 味守门规则

| 维度 | 实测 | 判定 |
|---|---|---|
| 形态 | `skills/taste-skill/SKILL.md` + `references/`(10 份) + `scripts/`(5 个 mjs) + `library/`(9 个 json) | 布局 **PASS**（`skills/<id>/SKILL.md`） |
| 体积 | `SKILL.md` **39537 字符** = 3.3 倍上限；截断到 12000 字符落在第 **181/542** 行，丢掉 `House rules`(382) / `Laws of the craft`(424) / `Special cases`(476) / `Files`(520) | **FAIL** |
| 附件体积 | `app-screens.md` 85KB、`motion.md` 55KB、`imagery.md` 51KB、`research.md` 24KB、`layout.md` 18KB … | 单个附件也远超一次回传的合理体积 |
| 运行时依赖 | `inspect.mjs` 走 CDP（`import { Browser, sleep } from './lib/cdp.mjs'`），`draw/assets/lint/scenes` 需 `node` 执行 | **本项目当前不具备**（脚本执行属 P4，见 `FEATURE_GAP_MATRIX.md` §9） |

**结论：只抄规则，不插脚本。** `SKILL.md` 的"守门"段落（House rules / Laws of the craft）正是用户要的"拦住难看的默认审美"，但它压在被截掉的 67% 里——**直接插进去，得到的正好是没有守门规则的 taste-skill**，比不插更糟。可行做法见 §4.3 的"规则前置"改写。

### 3.3 `addyosmani/agent-skills` — plan/build/test/review 一条线

| 维度 | 实测 | 判定 |
|---|---|---|
| 形态 | `skills/<id>/SKILL.md` × 25 | 布局 **PASS** |
| 元数据 | 25 份全部只有 `name` + `description`；`triggers` 命中 **0**，`allowed-tools` 命中 **0** | 需补两种字段 |
| 体积 | 9404–22216 字符，**15/25 超过 12000** | 与 README §11.4 记录的「15/25 超限」**实测复现，一致** |
| 危险命令（仅 SKILL.md 正文） | `rm -rf` **0**、`curl|bash` **0**；`git push`/`--force` 命中 3 份、`eval` 命中 2 份 | 需按语境人工判（见 §3.8） |

与项目现有 12 个内建技能的关系：**高度重叠**。内建已有 `code-review` / `test-cases` / `debug-first` / `verify-before-done` / `security-check` / `module-boundaries`，对应 addy 的 `code-review-and-quality` / `test-driven-development` / `debugging-and-error-recovery` / `security-and-hardening` / `api-and-interface-design`。**在 `MAX_ACTIVE_SKILLS=3` 的约束下，重复引入等于挤掉自己人。** 真正缺口只有三个：`planning-and-task-breakdown` / `spec-driven-development` / `context-engineering`（对应 P3 计划产物与上下文工程）。

### 3.4 `modelcontextprotocol/servers` — MCP 协议与沙箱样板

| 维度 | 实测 | 判定 |
|---|---|---|
| 现存 server | 只剩 **7 个**：`everything` `fetch` `filesystem` `git` `memory` `sequentialthinking` `time`（大量 server 已迁出到 archived 仓库） | 与"官方参考实现合集"的印象不同，实际规模小得多 |
| 沙箱边界实现 | `filesystem/path-validation.ts:11 isPathWithinAllowedDirectories`、`roots-utils.ts:79 getValidRootDirectories`、`pinned-directory.ts`（`isChildDirectory` / `overwriteFileInDirectory`） | **正是要抄的样板**：同时保存 root 的「声明形态」与「realpath 形态」，每次请求重新 realpath 校验 |
| `exec()` 滥用审计 | 全库 `child_process` / `spawn` / `exec` 在源码中命中 **0**（仅 2 处注释提及） | 用户担心的风险**在本仓库不成立**；但结论不可外推到任意第三方 MCP |

**结论：不是技能，是"MCP 客户端该怎么写"的参考实现。** 项目的 `fsx.rs` 三道校验（普通段 / 根目录存在 / canonicalize 逃逸检查）与之同构，**不需要推倒重来**，缺的是"root 声明 + 每次请求重新解析"这一层。

### 3.5 `microsoft/playwright-mcp` — 浏览器工具（审批边界是重点）

| 维度 | 实测 | 判定 |
|---|---|---|
| 工具规模 | **72 个** `browser_*` 工具名 | 远超项目现有 5 个工具 |
| 高危工具 | `browser_run_code_unsafe`（名字自带 unsafe）、`browser_evaluate`、`browser_file_upload`、`browser_fill_form`、`browser_cookie_set`、`browser_localstorage_set`、`browser_sessionstorage_set`、`browser_route`、`browser_network_request` | 能改外部状态 / 能执行代码 / 能写站点数据 |
| 分级开关 | `--caps=config / network / storage / devtools / vision / pdf` | **天然的审批分组维度** |
| 边界声明 | README 原文：`--allowed-origins` / `--blocked-origins` "**does not serve as a security boundary**" and "does not affect redirects" | **不能拿它当护栏**，审批必须自己做 |
| 其他面 | `--secrets <path>`（dotenv 凭证文件）、`--user-data-dir`（持久 profile，多实例冲突）、`--no-sandbox` | 每一项都是权限扩张点 |

**结论：走 MCP，不走技能库；默认 `Ask`，按 caps 逐项批，绝不进自动回路。**

### 3.6 `microsoft/agent-framework` — 编排 + skill 三级加载（抄设计）

| 维度 | 实测 | 判定 |
|---|---|---|
| 自带技能 | 顶层 `skills/` 下 **2 份**：`agent-framework-builder-python`(7047)、`agent-framework-builder-dotnet`(8260)，各带 `references/`(9 份) | 布局 PASS、**唯二不超限**、格式最干净（有 `license` + `metadata`） |
| 噪音 | 全库共 38 份 `SKILL.md`，其中 36 份散在 `python/samples/**`、`python/scripts/sample_validation/**` | **指向仓库根会扫进 36 份示例**，必须指向 `skills/` 子目录 |
| 渐进暴露 | `python/packages/core/agent_framework/_mcp.py:1181 use_progressive_disclosure`（且要求 `load_tools=True` 才生效） | 可直接抄进项目的 MCP 工具纳管：工具不全量注入 |
| 编排 | `python/packages/core/agent_framework/_workflows/`（`as_agent`）、`a2a/tests/test_a2a_group_chat.py`、ag-ui 的 `test_handoff_replay.py` | 顺序 / 并发 / 交接 / 群聊四种模式，对应项目 P5 |

**结论：Python/.NET SDK，装不进 Tauri；但它的技能形态是这 10 个里唯一"改一层就能用"的。**

### 3.7 `XiaomiMiMo/MiMo-Code` — 角色权限表（抄写法）

| 维度 | 实测 | 位置 |
|---|---|---|
| 权限合并顺序 | `Permission.merge(agent.permission, permission ?? [], agent.hardPermission ?? [])` —— **硬权限最后追加、不可被会话覆盖** | `packages/cli/src/agent/agent.ts:89`（`runtimePermission`） |
| 注释原文 | "Non-overridable rules appended AFTER the user/session permissions… Every permission-evaluation site routes [through here]" | `agent.ts:43-44`、`:85-89` |
| 角色现状 | `build`（完整工具）/ `plan`（只读）；`compose` 已 **retired**（`agent.ts:95` 注释 "including the retired `compose` agent"），编排改由 `compose-next` 技能承担 | `agent.ts:191`、README.zh.md:158-161、224-226 |

**这条对项目的价值最大**：它把"权限按角色强制分"落成了一句可验证的代码——`merge` 的三个参数顺序就是"谁说了算"。项目 P5 要求「子代理权限 ≤ 父级，且**有测试证明**」，直接对应这个写法：**父级约束放在 `hardPermission`（末位不可覆盖），子级只在前面收窄**。这是可单测的。

### 3.8 `browser-use` / `playwright` / `tauri`

| 仓库 | 实测 | 结论 |
|---|---|---|
| `browser-use` | Python 库（11M 快照）；开源库部分可用，云端浏览器与托管模型是付费层 | 不嵌入 Tauri；作为"浏览器智能体长什么样"的参考。与 Playwright 的分工：**确定性步骤用 Playwright 脚本，不确定步骤才交给模型** |
| `microsoft/playwright` | **BLOCKED**（未拉到） | 项目已在用（e2e 脚本），本次无新增证据，不据此下结论 |
| `tauri-apps/tauri` | **BLOCKED**（main/master 404，dev 下载中断）；元数据显示主仓顶层是 `crates/` `packages/` `examples/`，**无 `plugins-*` 目录** | 插件清单**未核实**，NOT PRESENT。v2 官方插件疑似在独立仓库，需单独核对后再谈"插件清单对齐" |

---

## 4. 针对本项目的接入设计

### 4.1 快照放哪（先解决"污染上下文"）

当前 `.refs/` 在工程根下，而目录树忽略清单只有 `node_modules / .git / target / dist / .zxz`（`src/lib/files.ts:136-147`），**`.refs` 的 8 个目录会出现在发给模型的目录树里**。

建议二选一（本次未改代码）：
- **A（推荐）**：快照移到 `<工程根>/.zxz/refs/`——`.zxz` 已被忽略，与 `undo/`、`audit/` 同类；
- **B**：给忽略清单加 `.refs`，并同步 `App.tsx` 侧的深度/上限不变。

### 4.2 分级处置（一张表定路线）

| 仓库 | 路线 | 入口 | 前置阶段 |
|---|---|---|---|
| `agent-framework` | 技能库（改 1 层） | 指向 `skills/` 子目录，补 `triggers`/`category`/`stage` | 现在可做 |
| `ui-ux-pro-max` | 技能库（重写） | 去重 13→1、重排布局、15969→≤12000、CSV 改查表 | 现在可做，但需按 §4.3 拆 |
| `taste-skill` | 技能库（只摘守门段） | 取 `House rules` + `Laws of the craft` 成独立技能，脚本步骤整段删除 | 现在可做 |
| `addyosmani` | 技能库（挑 3 个） | 只取 `planning-and-task-breakdown` / `spec-driven-development` / `context-engineering` | P3（与计划产物同批） |
| `servers` | MCP 客户端（抄协议） | `roots` 声明 + 每次请求 realpath，纳进 `ToolRegistry` | **P0-4 权限模型之后** |
| `playwright-mcp` | MCP + 单独审批 | 按 caps 分组，默认 `Ask`，不入自动回路 | P4，且必须有独立审批开关 |
| `browser-use` | 仅参考 | 不入依赖树 | — |
| `MiMo-Code` | 抄权限写法 | `hardPermission` 末位合并 → 子代理权限收敛 | P5（前置 P0-4） |
| `playwright` | 继续当 e2e 骨干 | 不变 | — |
| `tauri` | 插件逐项批 | **先核实插件清单**（本次 NOT PRESENT） | 按需 |

### 4.3 按需加载的具体做法（体量治理）

用户已点明"全量塞进提示词会烧 token"。结合实测，四条落地规则：

1. **正文只放"判断规则"，数据表一律下沉。** `ui-ux` 的 `colors.csv` 193 行 / `google-fonts.csv` 1935 行不能进正文；正文只写"要配色时 `@@ref: ui-ux-pro-max/data/colors.csv`"，由模型按需取。
2. **附件也要有体积门禁。** 项目现在有 `MAX_SKILL_REFS = 4`（一次最多取 4 个附件），但**没有单附件体积上限**——`google-fonts.csv` 747KB 一次回传会直接顶爆上下文。建议补一条附件体积上限（如 24000 字符，与 `@@read` 现有口径一致），超限回传"前 N 行 + 总行数"，让模型自己决定要不要缩小范围。
3. **超限正文禁止"截断后照用"。** 实测 `taste-skill` 截到 12000 字符 = 丢掉后 67%，且丢的正是守门规则。建议：正文 > 12000 时，技能卡片上把"超限"标成**阻断**而非提示——现在的 `skill.ts:272` 是截断 + 提示，用户看不出规则已被腰斩。
4. **同名 id 去重要显式报错。** `ui-ux` 的 13 份同名副本会静默互相覆盖。建议 `skillstore` 扫到同名 id 时列出全部路径让用户选，不要默认"后来者胜"。

### 4.4 MCP 的三条边界（对应 P4）

1. **工程根限制必须复用。** MCP 的 `filesystem` server 一旦接进来就是第二条写盘通道；它的 root 只能指向「当前工程根」，且每次请求走与 `fsx.rs` 同一套校验（普通段 + canonicalize），**不允许 MCP 自带 root 另开一个目录**。
2. **写入确认必须复用。** `confirmWrites` / `planMode` 的拦截点要在 `ToolRegistry` 层，而不是在各工具实现里——否则 MCP 工具天然绕过。
3. **工具清单逐个审，不打包信任。** 本次实测：`servers` 全库 `exec` 命中 0，但 `playwright-mcp` 有 `browser_run_code_unsafe` / `browser_evaluate` / `browser_fill_form` / `browser_cookie_set`。**"这个仓库干净"推不出"那个仓库干净"**，每个 server 接进来都要过一遍工具清单，并按 caps 分组授权。

### 4.5 浏览器能力的分层（对应"确定性 vs 模型自由发挥"）

| 层 | 用什么 | 审批 |
|---|---|---|
| 确定性验证（e2e、冒烟、回读校验） | Playwright 脚本（项目已在用） | 走现有 `runx` 白名单 |
| 不确定步骤（探索页面、判断"好不好看"） | 浏览器工具（`browser_*`） | **单独审批开关，默认关，不入自动测试回路** |
| 视觉审美检查（`taste-skill` 的 inspect） | 需 CDP + 脚本执行 | **当前不具备**，排到脚本执行能力之后（P4+） |

### 4.6 子代理权限的写法（对应 P5）

直接抄 `agent.ts:89` 的参数顺序：

```
effective = merge(agent.permission, session.permission, hardPermission)
                 └── 子级可收窄 ──┘   └── 父级/系统约束，末位不可覆盖 ──┘
```

项目要的"子代理权限 ≤ 父级，且有测试证明"，落到单测就是两条断言：
- 子代理声明 `write`、父级只有 `read` → 有效权限必须是 `read`；
- 会话层给 `exec`、父级 `hardPermission` 禁 `exec` → 有效权限必须无 `exec`。

### 4.7 分阶段建议（对齐现有 P0-P5）

| 阶段 | 动作 |
|---|---|
| **现在（P0 之后、无需新能力）** | 快照迁 `.zxz/refs/`；`agent-framework` 2 份改 frontmatter 后接入；`ui-ux` 去重重排后试插 1 个（验证同一技能是否挤掉另外两个坑） |
| **P3（计划产物 + 上下文）** | 接入 addy 的 3 个缺口技能；`taste-skill` 守门段独立成技能 |
| **P4（MCP）** | 抄 `servers` 的 roots 校验；`playwright-mcp` 按 caps 逐项批，默认 Ask；补附件体积门禁 |
| **P5（子代理）** | 用 `hardPermission` 末位合并实现权限收敛，配两条单测 |
| **待核实** | `tauri` 插件清单（本次 NOT PRESENT，核实后再谈逐项批） |

---

## 5. 未验证 / 存疑清单（不推断）

| 项 | 状态 | 说明 |
|---|---|---|
| `microsoft/playwright` 内容 | **BLOCKED** | 未拉到，本轮无任何新增证据 |
| `tauri` 插件清单 | **NOT PRESENT** | 主仓未拉全且无 `plugins-*` 目录；插件真实位置未核实 |
| `ui-ux` 完整内容 | **PARTIAL** | tarball 截断；已得 13 份 SKILL.md + data csv，但 `preview/`、`gallery/`、`projects/`、`docs/` 未验证完整性 |
| 危险命令语境判定 | **未做** | 本次只统计命中文件数（`git push`/`--force`/`eval`），未按项目三档语境（代码块 / 劝阻 / 正文）逐条判；**不给危险分**（纪律：同一条 `rm -rf` 写在卸载脚本是风险，写在拦截表里是防护） |
| 触发词冲突实测 | **未做** | 需先把第三方 `triggers` 补齐才能测；补齐前自动匹配对所有第三方技能均失效 |

---

## 6. 处置决策：哪些有用、哪些不可用

> 本节在上文实测基础上做取舍。判定口径：**有用** = 改造后能进技能库且对本项目（Tauri 2 + React 18 + 手写 CSS 的本地桌面外壳）有真实场景；**不可用** = 栈不匹配 / 需外部服务 / 被现状挡住 / 纯噪音。

### 6.1 有用（按优先级）

| # | 资产 | 体积 | 为什么有用 | 动作 |
|---|---|---|---|---|
| 1 | **ui-ux / `design-system`** | 7458 ✅ | 三层 token（primitive→semantic→component）+ CSS 变量；实测 Tailwind 仅 3 处、CSS 变量 6 处，**基本栈无关**——正好补"手写 CSS、没有设计系统"这个缺口 | 补 frontmatter 后直接接 |
| 2 | **ui-ux / `ui-ux-pro-max`** | 15969 ❌超限 | 192 配色 / 74 字体搭配 / 119 UX 规则的**查表型**知识库（数据在 `data/*.csv`，正文只当索引） | 瘦身到 ≤12000，CSV 改按需查表 |
| 3 | **taste-skill 守门段** | 39537 ❌超限 | `House rules`(382) + `Laws of the craft`(424) 就是"拦住 AI 味"的规则本体 | 摘出这两节独立成技能（预计 <8000），脚本步骤整段删 |
| 4 | **addy / `planning-and-task-breakdown`** | 10564 ✅ | 补 P3「计划产物」缺口 | 补 frontmatter |
| 5 | **addy / `spec-driven-development`** | 13099 ❌超限 | 同上，先有 spec 再写代码 | 瘦身 |
| 6 | **addy / `context-engineering`** | 15514 ❌超限 | 补 P3「上下文工程」缺口 | 瘦身 |
| 7 | **ui-ux / `design`** | 14196 ❌超限 | **只有一半有用**：设计令牌 + HTML 演示；logo 生成 / CIP 依赖 Gemini、Atlas Cloud、MuAPI 等外部图像 API | 拆：留令牌部分，删外部 API 部分 |

### 6.2 不可用 / 不值得

| 资产 | 判定 | 依据（实测） |
|---|---|---|
| **ui-ux / `ui-styling`** | **不可用（栈冲突）** | Tailwind 命中 **28**、shadcn **19**、原生 CSS 变量 **0** —— 强绑 Tailwind + shadcn，与本项目手写 CSS 正面冲突。体积虽合规（10945）也不能用 |
| **ui-ux / `banner-design`** | 无用 | 社媒/广告/印刷横幅，本地桌面端外壳无此场景 |
| **ui-ux / `slides`** | 无用 | HTML 演示文稿生成，同上 |
| **ui-ux / `brand`** | 无用 | 品牌声音/视觉识别/营销素材，同上 |
| **taste-skill 脚本层** | 不可用 | `node scripts/*.mjs` 被 `runx` 拒绝（见 `MCP_PREREQUISITE_AUDIT.md` §2 实测）；`inspect.mjs` 走 CDP，需浏览器能力 |
| **agent-framework 36 份示例技能** | 噪音 | 散在 `python/samples/**`、`python/scripts/sample_validation/**` |
| **addy 其余 22 个** | 不值得 | 与内建 12 个高度重叠（`code-review`/`test-cases`/`debug-first`/`security-check`/`module-boundaries` 已覆盖），而 `MAX_ACTIVE_SKILLS = 3` —— 引入等于挤掉自己人 |
| **addy / `using-agent-skills`** | 低价值 | 元技能，管"如何发现/调用技能"，项目已有自己的加载与匹配机制 |
| **browser-use** | 不可用（可看） | Python 库，装不进 Tauri；云端浏览器与托管模型是付费层 |
| **`playwright` / `tauri`** | NOT PRESENT | 未拉到 / 插件清单未核实，不推断 |

### 6.3 建议的启用组合（`MAX_ACTIVE_SKILLS = 3`）

| 阶段 | 三个坑怎么填 |
|---|---|
| 现在（重 UI、重设计系统） | `design-system` + `ui-ux-pro-max`(瘦身) + `taste-guard`(守门段) |
| P3（计划与上下文） | 换入 `planning-and-task-breakdown` + `spec-driven`(瘦身) + `context-engineering`(瘦身) |

### 6.4 非技能资产（不走技能库，但有价值）

| 资产 | 用法 | 时间 |
|---|---|---|
| `MiMo-Code` | 抄 `agent.ts:89` 的 `hardPermission` 末位合并 → 子代理权限收敛（可单测） | P5 |
| `servers` | 抄 `roots` 声明 + 每次请求 realpath 的沙箱边界 | P4（P0-4 之后） |
| `playwright-mcp` | 72 个 `browser_*` 按 `--caps` 分组审批，默认 `Ask` | P4 |
| `agent-framework` | 编排四种模式 + `use_progressive_disclosure`（工具渐进暴露）；其 2 份技能也是**格式范本** | 参考，不装 |

---

*本轮为 AUDIT-ONLY：未修改 `src/` 下任何业务代码，未改动 `src/skills/sources.ts` 的来源登记表。*
