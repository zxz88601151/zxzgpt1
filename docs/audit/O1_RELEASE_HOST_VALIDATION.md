# O1 · Release 宿主重编与真实桌面端实测（2026-11-02）

> 授权范围：业主指令「依次 O1 重编宿主（同时才能真正验掉 Q3 与 D17）、D16 斜杠命令收窄、
> D11 文档测试数对齐、提交/推送」。本文只覆盖 **O1 重编 + 真机实测**，对应
> `P0-2_IMPLEMENTATION_PLAN.md` §9 的 Q3 桌面端缺口与 `TECHNICAL_DEBT.md` 的 D17 / D16 / D18。
>
> **最终状态：PASS_WITH_CONDITIONS**（条件见 §6 证据缺口）。

---

## 1. 构建与产物对应

| 项 | 值 |
|---|---|
| 构建命令 | `RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu npx tauri build --no-bundle` |
| 产物 | `src-tauri/target/release/zxz.exe` 5,068,288 B |
| 新产物 sha256 | `d15320c7ebcc2a183c6769702c5dc026cfffb15b958ce1d0ff3effe0ef6b8049` |
| 旧产物 sha256（备份保留） | `7d17eb310f92b53a0a45f35619ba0caca4136231fc5d673372896288c7accc33` |
| 构建日志 | `%TEMP%\c1d\q23\tauri-build-gnu.log`（`Finished release profile in 3m 50s`） |
| 内嵌前端 | `dist/assets/index-CQlZK13B.js`（资源名在产物内命中 1 次，与本次 vite 构建同名） |

**工具链事实**（影响后续所有构建）：本机无 MSVC（无 vswhere / 无 VS 目录），
rustup 默认 toolchain 是 msvc，直接 `npx tauri build` 会因 Git for Windows 的 coreutils
`link.exe` 抢占而失败（`link: extra operand …`），**且后台包装器仍上报 exit 0**。
→ 构建成败必须读日志，不能信退出码。

### 1.1 二进制内容级取证（三条串比对）

| 探针 | 新 release（交付） | 旧 release（备份） | 旧 debug（D17 污染产物） |
|---|---|---|---|
| `img-src 'self' data: blob:;` | **2**（csp + devCsp） | 0 | 0 |
| `img-src 'self' data: blob: http: https:;`（Q3 前旧串） | **0** | 0 | 2 |
| `remote-debugging` | **0** | 0 | **1**（`--remote-debugging-port=9223`） |
| `default-src` | 2 | **0**（早于 P0-2 配 CSP） | 2 |
| `ws_open` / `fs_list_in` / `proxy_info` / `会话已关闭` | 1 / 1 / 1 / 2 | 0 / 0 / 0 / 0 | 4 |
| 前端错误串 `未知命令`、`空命令`（D16 已删分支） | 产物内 0；`dist` 内 0 | — | 不嵌前端（dev 态走 vite） |
| D16 保留分支 `后面不带参数` / `只接受` / `要跟`（在 `dist` 内） | 2 / 1 / 2 | — | — |

结论：交付产物与当前工作树（Q3 CSP + D16 前端 + P0-1 会话化 IPC）**对应关系成立**；
旧 release 产物连 CSP 都没有，本就不能当验证宿主 —— 这条同时解释了为什么 Q3 之前只能停在"源码已改，宿主未验"。

---

## 2. 为什么必须另建 CDP 变体（对 D17 建议② 的推翻）

`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 在 **release 产物上完全无效**：

- 探针：注入 `--remote-debugging-port=9224 --remote-allow-origins=* --user-agent=RELMARKER77X` 启动交付产物；
- 结果：7 个 `msedgewebview2.exe` 子进程命令行里 `RELMARKER77X` **0 命中**、`remote-debugging` **0 命中**，
  `127.0.0.1:9224` **不监听**；
- 同一进程同一方式下 `WEBVIEW2_USER_DATA_FOLDER` **正常生效**（子进程带 `--user-data-dir=…\profile-rel2\EBWebView`）
  → 排除"环境变量没传下去"这一解释；
- 源码定位：`wry-0.57.1/src/webview2/mod.rs:305-333` —— release 走 wry 默认非空串
  （`--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection` + `--autoplay-policy=…`），
  该串存在时环境变量不再参与；debug 产物里这一位是空的，所以 C1-D1 轮的环境变量法"看起来有效"。

**这既推翻建议②，也给出一条正面结论：交付产物无法被外部用环境变量偷偷开 CDP。**

真机测 release 产物只剩构建期注入一条路。本轮做法：

```
npx tauri build --no-bundle --config <TEMP>/c1d/src/cdp-config.json
```

`cdp-config.json` 放在 TEMP，**仓库 `tauri.conf.json` 一个字节都没改**；它只补
`app.windows[0].additionalBrowserArgs`（其余窗口字段按原值全量重写，避免数组被整体替换时丢字段）。

### 2.1 变体 ↔ 交付产物 同源证明（逐串比对，4 项差异全是注入参数）

| 探针 | 交付产物 A | 被测变体 B |
|---|---|---|
| `img-src 'self' data: blob:;` | 2 | 2 |
| `img-src 'self' data: blob: http: https:;` | 0 | 0 |
| `script-src 'self';` / `script-src 'self' 'unsafe-inline';` | 1 / 1 | 1 / 1 |
| `connect-src 'self' ipc: http://ipc.localhost http://tauri.localhost http: https:;` | 1 | 1 |
| `object-src 'none';` / `frame-ancestors 'none';` | 2 / 2 | 2 / 2 |
| `index-CQlZK13B.js` / `index-BJpXV7Et.css` / `avatar-sm-DlOOgIuV.png` | 1 / 1 / 1 | 1 / 1 / 1 |
| `ws_open` / `fs_list_in` / `proxy_info` / `会话已关闭` | 1 / 1 / 1 / 2 | 1 / 1 / 1 / 2 |
| `--remote-debugging-port=9224` / `--remote-allow-origins` | 0 / 0 | **1 / 1** |
| `--disable-features=msWebOOUI,…` / `--autoplay-policy=…` | 1 / 1 | **2 / 2** |

大小 5,068,288 → 5,068,800（+512 B，即注入的串）。测完把交付产物原样还原，
sha256 复核仍为 `d15320c7ebcc2a18…`。

---

## 3. 隔离与安全边界（沿用 C1-D1 的硬约束）

| 约束 | 实测 |
|---|---|
| 独立 user-data-dir | 三次启动分别落 `profile-rel` / `profile-cdp` / `profile-ship`，子进程命令行逐条确认；真实 Edge/WebView2 用户目录未被使用 |
| 不污染真实状态 | 测试配置写入隔离 profile 的 `zxz.state.v1`（baseUrl 指向本机 mock），`convCount=0` 起步 |
| 只清理本轮进程 | 逐个用本轮记录的 PID 树 `taskkill /T /F`（16580 / 16532 / 16484 / 7368 / mock 14020·13600·17048）；收尾 `zxz`、`msedgewebview2` 计数 0，19889/19890/9224 监听 0 |
| 交付产物不带调试口 | `-NoCdp` 启动交付产物：子进程 `remote-debugging` 0 命中，9223/9224 监听 0 |
| 不改仓库脚本/不动 .tmp-ws | `tools/` 零改动（mock 与驱动全在 TEMP）；`.tmp-ws` 未触碰 |
| 不误提交测试目录 | 发现并删除我自己产生的 0 字节杂项文件 `C`（14:26 由一次重定向写错产生）；`.refs/`、`.tmp-skills/` 未纳入暂存 |

---

## 4. 真机实测结果（R0–R9，31 条：27 PASS + 4 INFO + 0 FAIL）

驱动：CDP 连本机 9224 的 release 宿主 WebView2（`url=http://tauri.localhost/`），
上游用 TEMP 里的 OpenAI 兼容 mock（SSE）+ 一台跨源图片服务器（带命中计数）。

| 组 | 断言 | 结果 |
|---|---|---|
| R0/R1 | 连上真实宿主页面；状态注入生效且落在隔离 profile | PASS |
| R2 | 同源 `/assets/avatar-sm-*.png` HEAD 200；页面自带头像正常加载（`img-src` 保留 `self` 未受伤） | PASS |
| **R3 D16** | 输入 `/etc/hosts 里的 127.0.0.1 是干嘛的` → 上游请求 **+1**、`lastUserContent` **逐字一致**、会话落 1 user + 1 assistant、输入框清空 | PASS |
| **R4 Q3** | 跨源 `http://127.0.0.1:19890/remote.png` 的 `<img>` **元素确实生成**（证明 Markdown 解析正常）→ `naturalWidth=0` → **图片服务器零新增命中**（根本没发请求）→ 同源头像照常 → 控制台留下 CSP 违规原文 | PASS |
| **R5 Q4** | 渲染探针的那段文本 `innerHTML` 只有 `&lt;svg/onload=alert(1)&gt;`；容器内 `svg` 0、`[onload]` 0；全 DOM `onload` 0、`svg animate/set` 0；`window.alert` 未执行 | PASS |
| R6 C1 回归 | `/plan 开` 不走上游、`settings.planMode=true`、toast 文案即 `appActionLabel` 的「计划模式已开启」、输入清空 | PASS |
| R7 D16 代价 | `/zzz 开` 现在按普通消息发出（`lastUserContent="/zzz 开"`）——这是 D16 收窄的**已知代价**，实测确认 | PASS |
| R8 F1 回归 | `/plan 也许吧` 不发送、报错 toast、输入**逐字保留** | PASS |
| R9 | 除 CSP 违规外 console error 0、pageerror 0 | PASS |

截图（真实桌面窗口，非浏览器注入）：`rel-01-boot` / `rel-02-d16-passthrough` /
`rel-03-csp-imgsrc` / `rel-04-keep-input`，均在本机 `%TEMP%\c1d\shots\`。

### 4.1 本轮自己踩的两个测试坑（都已修正，记录以免复发）

1. **假阴性/假阳性混淆**：mock 监听 19890，但回复正文里的图片 URL 写成 18990（端口没人监听）。
   这样"被 CSP 拦"和"端口是死的"看起来一模一样。修正为同一端口后，
   R4a（元素存在）+ R4c（零网络命中）+ R4e（CSP 原文）才构成完整链条。
2. **`<svg>` 计数断言写错**：应用界面本身就有 15 个图标 `<svg>`，且每条助手消息的头像、
   发送/停止按钮切换都会增减数量。绝对计数断言必然假失败。
   改为**归因断言**：做一轮不含探针的对照回复（`S1` delta=2）与一轮含探针（`S2`），
   并直接定位"真正渲染出探针文本的那个容器"，断言其内部 `svg=0`、`[onload]=0`、
   `innerHTML` 只有转义实体。追查到的 2 个消息树内 `<svg>` 全部是
   `article.msg.assistant > .msg-head > span.avatar > svg`（应用自带头像图标）。

---

## 5. 对既有结论的影响

- **Q3**（`img-src` 收紧）：由"源码已改 + 静态枚举过图片面"升级为**真机实测通过**；
  同源头像与 `blob:` 导出未受影响（`blob:` 见 §6 缺口声明）。
- **D17**：产物 ↔ 源码从取证问题变成可复核的串比对；建议② 被推翻并已改写。
- **D18**：`devCsp` 的 `script-src 'unsafe-inline'` 仍在（Q2 结论未变），
  本轮实测再次确认交付产物的 `csp` 是 `script-src 'self'`（无 unsafe-inline）。
- **D16**：桌面端行为与单测一致，且新增实测确认其代价（`/zzz 开` 透传）。
- **D11**：本轮复测**撤回**两条旧证据（proxy token / Host 校验），HEAD 早已实现，
  详见 `TECHNICAL_DEBT.md` D11「撤回」。

---

## 6. 证据缺口（不推断通过）

1. **R0–R9 跑在"仅多一个浏览器参数"的 release 变体上**，不是交付产物的同一批字节。
   两者的差异已逐串钉死（§2.1），交付产物另经 §1.1 串比对 + §3 无调试口启动验证；
   但"在交付产物本体上点一遍 UI"这一步没做——它需要 CDP，而 CDP 只能构建期注入。
2. **`data:` / `blob:` 图片的运行时放行未单独断言**：本轮只实测了 `self` 放行与 `http` 被拦；
   `data:` 仅由 favicon 与 CSP 串存在性间接支撑。
3. **`connect-src` 仍含 `http: https:`**（Q3 只收 `img-src`），跨源网络出口面未变。
4. **构建元数据（D17 建议③）未做**：产物 ↔ 源码目前仍靠串比对钉，不能 `--version` 直接读出 commit。
5. **污染的 debug 产物仍在** `target/debug/zxz.exe`（内嵌 9223），未重编未删除。
