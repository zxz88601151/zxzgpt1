// 文件读写自检 harness
//
// 为什么需要它：`cargo test --lib` 在这台机器上会因 tauri 的 WebView2 导入库
// 不匹配而 0xc0000139（STATUS_ENTRYPOINT_NOT_FOUND），测试进程根本起不来。
// 这里用 #[path] 直接引用 `src-tauri/src/fsx.rs` 原文（该模块不依赖 tauri），
// 于是路径校验逻辑与真实写盘行为都能在本机真跑一遍。
//
//   cargo test          # 路径安全单测 + 真实落盘
//   cargo run -- <dir>  # 对指定目录做一次写入演练

#[path = "../../../src-tauri/src/fsx.rs"]
mod fsx;

#[path = "../../../src-tauri/src/runx.rs"]
mod runx;

#[path = "../../../src-tauri/src/wsx.rs"]
mod wsx;

#[path = "../../../src-tauri/src/perms.rs"]
mod perms;

fn main() {
    let dir = std::env::args().nth(1).unwrap_or_else(|| std::env::temp_dir().to_string_lossy().to_string());
    println!("roots = {:?}", fsx::roots());
    println!("list  = {:?}", fsx::list(dir.clone()).map(|v| v.len()));
    // 会话通道演练：登记一次目录，之后只靠 sessionId 读写
    match wsx::open(&dir) {
        Ok(s) => match wsx::root_of(&s.id) {
            Ok(root) => println!(
                "session {} -> write = {:?}",
                s.id,
                fsx::write(&root, ".zxz-harness/probe.txt", "ok".into()).map(|r| r.created)
            ),
            Err(e) => println!("会话 root 取不到：{e}"),
        },
        Err(e) => println!("会话登记失败：{e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::fsx;
    use std::fs;
    use std::path::PathBuf;

    /// 工程根必须是 canonicalize 后的真实路径：会话登记时会做这一步，测试里对齐
    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zxz-fsx-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(&d).unwrap()
    }

    #[test]
    fn writes_and_creates_parents() {
        let root = tmp("write");
        let r = fsx::write(&root, "src/lib/a.ts", "export const a = 1;\n".into()).unwrap();
        assert!(r.created);
        assert_eq!(fs::read_to_string(root.join("src/lib/a.ts")).unwrap(), "export const a = 1;\n");
    }

    #[test]
    fn overwrite_reports_not_created() {
        let root = tmp("overwrite");
        fsx::write(&root, "a.txt", "v1".into()).unwrap();
        let r = fsx::write(&root, "a.txt", "v2".into()).unwrap();
        assert!(!r.created);
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "v2");
    }

    #[test]
    fn read_round_trip() {
        let root = tmp("read");
        fsx::write(&root, "docs/readme.md", "# hi 你好".into()).unwrap();
        assert_eq!(fsx::read(&root, "docs/readme.md").unwrap(), "# hi 你好");
    }

    #[test]
    fn rejects_escape_at_runtime() {
        let root = tmp("escape");
        assert!(fsx::write(&root, "../outside.txt", "x".into()).is_err());
        assert!(fsx::read(&root, "../outside.txt").is_err());
        // 确认真的没写出去
        assert!(!root.parent().unwrap().join("outside.txt").exists());
    }

    #[test]
    fn rejects_read_of_missing() {
        let root = tmp("missing");
        assert!(fsx::read(&root, "nope.txt").is_err());
    }

    #[test]
    fn list_sorts_dirs_first() {
        let root = tmp("list");
        fs::create_dir_all(root.join("zdir")).unwrap();
        fs::write(root.join("afile.txt"), "x").unwrap();
        let entries = fsx::list(root.to_string_lossy().to_string()).unwrap();
        assert!(entries[0].dir, "目录应排在前面");
        assert_eq!(entries[0].name, "zdir");
        assert_eq!(entries[1].name, "afile.txt");
    }
}

/// 会话端到端：登记一次目录，之后所有读写只靠 sessionId
#[cfg(test)]
mod wsx_tests {
    use super::wsx;
    use std::fs;
    use std::path::PathBuf;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zxz-wsx-h-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(&d).unwrap()
    }

    #[test]
    fn session_round_trip_write_then_read() {
        let dir = tmp("round");
        let s = wsx::open(&dir.to_string_lossy()).unwrap();
        let root = wsx::root_of(&s.id).unwrap();
        super::fsx::write(&root, "src/a.ts", "x".into()).unwrap();
        assert_eq!(super::fsx::read(&root, "src/a.ts").unwrap(), "x");
        // 关闭之后同一个 id 立刻失效
        wsx::close(&s.id).unwrap();
        assert!(wsx::root_of(&s.id).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn forged_session_id_is_rejected() {
        assert!(wsx::root_of("").is_err());
        assert!(wsx::root_of("ws-deadbeef").is_err());
        assert!(wsx::root_of("../etc").is_err());
        // 会话 id 不能是路径：拿不到 root 就没有任何落点
        assert!(wsx::root_of(&std::env::temp_dir().to_string_lossy()).is_err());
    }

    #[test]
    fn session_scopes_the_same_rel_to_its_own_root() {
        // 两个会话可以同时活着：同一个 rel 落在各自的工程根，互不干扰
        let a = tmp("scopea");
        let b = tmp("scopeb");
        let sa = wsx::open(&a.to_string_lossy()).unwrap();
        let sb = wsx::open(&b.to_string_lossy()).unwrap();
        super::fsx::write(&wsx::root_of(&sa.id).unwrap(), "same.txt", "A".into()).unwrap();
        super::fsx::write(&wsx::root_of(&sb.id).unwrap(), "same.txt", "B".into()).unwrap();
        assert_eq!(super::fsx::read(&wsx::root_of(&sa.id).unwrap(), "same.txt").unwrap(), "A");
        assert_eq!(super::fsx::read(&wsx::root_of(&sb.id).unwrap(), "same.txt").unwrap(), "B");
        wsx::close(&sa.id).unwrap();
        wsx::close(&sb.id).unwrap();
        let _ = fs::remove_dir_all(&a);
        let _ = fs::remove_dir_all(&b);
    }
}

#[cfg(test)]
mod runx_tests {
    use super::perms;
    use super::runx;
    use super::wsx;
    use std::fs;
    use std::path::Path;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{Duration, Instant};

    fn argv(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// 铺一个最小 npm 工程：`npm run build` 是白名单命令，用它把各种子进程行为
    /// （非零退出、超大输出、跑不完）引出来。
    /// scripts.build 固定 `node --test emit.js`：`node --test` 在受信任运行器清单里
    /// （runx 会审计脚本内容，`node emit.js` 这类会被拒）。runner 语义：
    /// 用例文件里非零退出/失败 → 父进程 exit 1；子进程 stdout 直通父 stdout，
    /// 子进程 stderr 以 TAP 注释（`# E…`）并进 stdout。每种场景只换 emit.js 内容。
    fn npm_project(tag: &str, emit_js: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zxz-runx-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        const PKG: &str = r#"{"name":"zxz-runx-fixture","version":"1.0.0","private":true,"scripts":{"build":"node --test emit.js"}}"#;
        fs::write(d.join("package.json"), PKG).unwrap();
        fs::write(d.join("emit.js"), emit_js).unwrap();
        d
    }

    #[test]
    fn allowlist_mirrors_frontend() {
        assert!(runx::is_allowed(&argv(&["npm", "test"])).is_ok());
        assert!(runx::is_allowed(&argv(&["npm", "run", "build"])).is_ok());
        assert!(runx::is_allowed(&argv(&["git", "diff", "--stat"])).is_ok());
        assert!(runx::is_allowed(&argv(&["npm", "install"])).is_err());
        assert!(runx::is_allowed(&argv(&["git", "push"])).is_err());
        assert!(runx::is_allowed(&argv(&["npm", "test", "a;rm -rf ."])).is_err());
    }

    #[test]
    fn run_git_status_in_temp_dir_reports_not_fails_to_spawn() {
        // 临时目录不是 git 仓库：git status 会非零退出，但命令本身必须能跑起来
        // 并且输出被捕获，而不是“启动失败”。这验证的是执行层，不是 git 语义。
        // 「不是仓库」的报错走 git 的 stderr——顺带证明 stderr 管道也在被独立排空。
        // 落点选 target/ 下（已忽略，测试残留不会脏 git status）。runx 执行时给
        // 子进程设了 GIT_CEILING_DIRECTORIES（工程根即停，不会向上被父仓库兜住），
        // 所以本地与 CI 都稳定「非仓库」：exit 非 0、报错走 stderr，
        // 顺带证明 stderr 管道也在被独立排空。
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/.tmp-runx-git");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let r = runx::run_allowed(&dir, &argv(&["git", "status"])).unwrap();
        assert!(!r.timed_out);
        assert_ne!(r.exit_code, Some(0), "环境变了：target 下被上级 git 仓库兜住了");
        assert!(!r.stderr.is_empty(), "git 的报错必须从 stderr 管道收回来");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nonzero_exit_code_reaches_the_test_loop() {
        // 自动测试回路靠退出码判断「测试过没过」：用例里 process.exit(3) 会被
        // node --test 归一成「测试失败」，父进程必须非零，且子进程输出要能回传。
        let dir = npm_project(
            "exit",
            "console.log('boom-stdout');\nprocess.exit(3);\n",
        );
        let r = runx::run_allowed(&dir, &argv(&["npm", "run", "build"])).unwrap();
        assert!(!r.timed_out, "退出码用例不该触发超时");
        assert_eq!(
            r.exit_code,
            Some(1),
            "测试失败必须透传为非零退出码，stdout={:?}",
            r.stdout.chars().take(200).collect::<String>()
        );
        assert!(r.stdout.contains("boom-stdout"), "子进程输出必须回传：{:?}", r.stdout.chars().take(200).collect::<String>());
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn truncates_huge_output_and_does_not_deadlock() {
        // 双线程排空管道 + 20000 字符截断：stdout 给到远超管道缓冲区的量，
        // 看会不会卡死（卡死就是 read 线程被管道缓冲堵住没人排空的经典 bug）。
        // node --test 的子进程 stderr 被 runner 以 TAP 注释并进父 stdout，
        // 这条只验 stdout 截断；stderr 通道由 git 用例单独证明。
        let dir = npm_project(
            "bigout",
            "process.stdout.write('O'.repeat(300000) + '\\n');\n",
        );
        let t0 = Instant::now();
        let r = runx::run_allowed(&dir, &argv(&["npm", "run", "build"])).unwrap();
        let spent = t0.elapsed();
        let _ = fs::remove_dir_all(&dir);

        assert!(spent < Duration::from_secs(45), "30 万字符输出花了 {spent:?}，疑似管道堵死");
        assert!(r.truncated, "超长输出必须标记 truncated");
        assert_eq!(r.stdout.chars().count(), 20000, "stdout 截断不到位");
    }

    /// 超时分支要真跑 60 秒，日常 `cargo test` 不划算，所以默认跳过：
    /// cargo test -- --ignored 才会跑。
    #[test]
    #[ignore = "要实打实等 60 秒超时，按需跑：cargo test -- --ignored"]
    fn timeout_kills_the_child_and_reports_it() {
        // node --test 会再起一层 runner 子进程跑 emit.js：它先写下自己的 pid，
        // 再挂一个比超时更久的定时器。如果 kill 没覆盖进程树，run_allowed 返回后
        // finished.txt 才会出现、或 pid 还活着，据此判断子进程死没死透。
        let dir = npm_project(
            "timeout",
            "require('fs').writeFileSync('alive.txt', String(process.pid));\n\
             setTimeout(function () { require('fs').writeFileSync('finished.txt', 'done'); }, 95000);\n",
        );
        let t0 = Instant::now();
        let r = runx::run_allowed(&dir, &argv(&["npm", "run", "build"])).unwrap();
        let spent = t0.elapsed();

        println!(
            "run_allowed 在 {spent:?} 返回：timed_out={} exit_code={:?}",
            r.timed_out, r.exit_code
        );
        assert!(!dir.join("finished.txt").exists(), "刚返回时子进程不该已经跑完");
        let pid: u32 = fs::read_to_string(dir.join("alive.txt")).unwrap().trim().parse().unwrap();
        std::thread::sleep(Duration::from_secs(3));
        let leak = pid_alive(pid);
        println!("孙进程 pid={pid} 是否还活着：{leak}");
        let _ = fs::remove_dir_all(&dir);

        assert!(r.timed_out, "跑不完的命令必须标记 timed_out");
        assert!(
            spent < Duration::from_secs(runx::RUN_TIMEOUT_SECS + 10),
            "实际耗时 {spent:?}，超时没兜住——调用方被拖到子进程自然结束才返回"
        );
        assert!(!leak, "超时后仍有存活孙进程：kill 没覆盖进程树");
    }

    /// 命令工作目录只能来自已登记的会话：cwd 与会话同生同死
    #[test]
    fn command_cwd_dies_with_its_session() {
        let dir = npm_project("sess", "console.log('ok');\n");
        let s = super::wsx::open(&dir.to_string_lossy()).unwrap();
        let cwd = super::wsx::root_of(&s.id).unwrap();
        assert_eq!(cwd, fs::canonicalize(&dir).unwrap(), "cwd 必须是会话登记的真实目录");
        assert!(runx::run_allowed(&cwd, &argv(&["git", "--version"])).is_ok());

        super::wsx::close(&s.id).unwrap();
        // 关掉会话后拿不到 cwd，命令也就无从落点
        assert!(super::wsx::root_of(&s.id).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    /// Windows 上查某个 pid 还在不在（超时用例用来观察进程树有没有漏杀）
    fn pid_alive(pid: u32) -> bool {
        let Ok(o) = Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output() else {
            return false;
        };
        String::from_utf8_lossy(&o.stdout).contains(&pid.to_string())
    }

    /// 这些键不是「从宿主环境继承」来的，而是执行器/沙箱在子进程里自己加的：
    /// - `npm_*` / `NPM_*` / `INIT_CWD` / `EDITOR`：npm 执行 scripts 时自设
    ///   （脚本名、包名、execpath、默认编辑器）；
    /// - `NODE*`：node --test runner 与 npm.cmd 里的 SET 语句（NODE_EXE 等）；
    /// - `PROMPT` / `COLOR`：Windows 上 .cmd 由 cmd.exe 执行，cmd 会补自己的默认值；
    /// - `LSBOX_*` / `SANDBOX_IPC_TRACE_*` / `MSYSTEM`：本机沙箱在进程启动时注入。
    ///   依据：`env -i PATH=… node -e 'Object.keys(process.env)'` 在**完全清空**
    ///   的环境下仍然打印出这四个键——它不走环境块，应用层的 env_clear 管不到。
    ///
    /// 把它们排除不是为了让断言变松：真正的判据是「宿主继承面必须为空」，
    /// 下面用对照组（直接 spawn）证明宿主确实有一批可继承的变量，
    /// 再用被测组证明同样这批一个都没传进去。
    fn not_inherited(k: &str) -> bool {
        k.starts_with("npm_")
            || k.starts_with("NPM_")
            || k.starts_with("NODE")
            || matches!(k, "INIT_CWD" | "EDITOR" | "PROMPT" | "COLOR" | "MSYSTEM")
            || k.starts_with("LSBOX_")
            || k.starts_with("SANDBOX_IPC_TRACE_")
    }

    /// 子进程的环境必须是「白名单 + 执行器注入」，不该带上宿主的任何东西。
    ///
    /// 这条路径跑的是模型提议的命令，npm 脚本 / vite 插件 / node --test 文件
    /// 都是会在子进程里执行的代码——继承宿主环境等于把 API Key、代理口令、
    /// CI token 交给模型侧能读到输出的代码（`console.log(process.env)` 就够）。
    ///
    /// 不用「往宿主塞哨兵」的写法：set_var 是进程级全局状态，会和并发跑的
    /// 其它用例互相污染。这里让子进程自报键名，再比集合。
    #[test]
    fn child_env_is_whitelist_not_a_copy_of_host() {
        let dir = npm_project("envkeys", "console.log('ENV_KEYS:' + Object.keys(process.env).sort().join(','));\n");
        let allowed = runx::allowed_env_keys();

        // 对照组：同一份脚本直接 spawn。它必须能拿到一批「白名单外的宿主变量」，
        // 否则说明本机环境本来就干净，这条用例证明不了隔离。
        let direct = Command::new("node").args(["--test", "emit.js"]).current_dir(&dir).output().expect("对照组：本机必须能跑 node");
        let direct_out = String::from_utf8_lossy(&direct.stdout).to_string();
        let direct_inherited: Vec<String> = env_keys_of(&direct_out)
            .into_iter()
            .filter(|k| !allowed.contains(k) && !not_inherited(k))
            .map(String::from)
            .collect();
        assert!(
            !direct_inherited.is_empty(),
            "对照组失效：直接 spawn 也拿不到白名单外的宿主变量，本机环境太干净，这条用例说明不了问题"
        );

        // 被测组：经 run_allowed，同样这批变量必须一个都不剩
        let r = runx::run_allowed(&dir, &argv(&["npm", "run", "build"])).unwrap();
        assert!(r.stdout.contains("ENV_KEYS:"), "脚本没跑起来，断言无意义：{:?}", r.stdout.chars().take(300).collect::<String>());
        let keys: Vec<String> = env_keys_of(&r.stdout).into_iter().map(String::from).collect();
        assert!(!keys.is_empty(), "没解析到子进程环境键名");
        let leftover: Vec<&String> = keys.iter().filter(|k| !allowed.contains(&k.as_str()) && !not_inherited(k)).collect();
        assert!(leftover.is_empty(), "宿主环境变量被继承进去了（泄漏面，对照组里同样存在）：{leftover:?}");

        // 威胁面断言：高危项一个都不能有，哪怕宿主里设了
        for banned in ["NODE_OPTIONS", "npm_config_script_shell", "NPM_CONFIG_SCRIPT_SHELL"] {
            assert!(!keys.iter().any(|k| k == banned), "{banned} 出现在子进程环境里：启动即执行面");
        }
        assert!(!keys.iter().any(|k| {
            let u = k.to_ascii_uppercase();
            u.contains("TOKEN") || u.contains("SECRET") || u.contains("PASSWORD") || u.ends_with("_KEY")
        }), "子进程环境里出现疑似凭据变量：{keys:?}");

        // 反之，工具链自己要用的必须还在——不然不是「隔离」而是「跑不起来」
        for need in ["PATH", "APPDATA", "SYSTEMROOT"] {
            assert!(keys.iter().any(|k| k.eq_ignore_ascii_case(need)), "白名单把工具链依赖的 {need} 也挡掉了");
        }

        let _ = fs::remove_dir_all(&dir);
    }

    /// 从 node --test 的 TAP 输出里取出 `ENV_KEYS:a,b,c` 那一行的键集合
    fn env_keys_of(stdout: &str) -> Vec<&str> {
        for line in stdout.lines() {
            if let Some(pos) = line.find("ENV_KEYS:") {
                let raw = &line[pos + "ENV_KEYS:".len()..];
                // TAP 会给子进程输出加 `# ` 前缀或尾随内容，取到非标识符字符为止
                let end = raw.find(|c: char| !(c.is_alphanumeric() || c == '_' || c == ',')).unwrap_or(raw.len());
                return raw[..end].split(',').filter(|s| !s.is_empty()).collect();
            }
        }
        Vec::new()
    }

    /// 捕获上限是**内存**上限，不是展示上限：限流前读线程会把子进程吐的一切
    /// 都 extend 进 Vec，然后才截断到 20000 字符——先吃满再削，等于没限。
    #[test]
    fn oversized_output_is_capped_and_still_finishes() {
        let dir = npm_project("capout", "process.stdout.write('X'.repeat(2 * 1024 * 1024));\n");
        let t0 = Instant::now();
        let r = runx::run_allowed(&dir, &argv(&["npm", "run", "build"])).unwrap();
        let spent = t0.elapsed();
        let _ = fs::remove_dir_all(&dir);

        assert!(spent < Duration::from_secs(45), "2MB 输出花了 {spent:?}，疑似管道堵死");
        assert!(r.truncated, "超限输出必须标记 truncated");
        assert_eq!(r.stdout.chars().count(), 20000, "展示层截断失败");
        assert!(r.exit_code.is_some(), "超限不能把退出码弄丢——那会让测试回路误判通过");
    }

    /// exec 默认 ask 的端到端证据。
    ///
    /// 「闸门拒绝了」这句话本身不是证据——命令可能压根起不来（脚本写错、
    /// npm 不在 PATH），那样 marker 也不会出现，测试会假通过。所以必须同时有
    /// 对照组：授权之后同一条命令要真的跑起来、真的写出 marker。
    /// 只有「未授权不出现 + 授权后出现」这一对，才证明拦的是执行本身。
    #[test]
    fn unapproved_exec_cannot_start_a_process() {
        let dir = npm_project("permgate", "require('fs').writeFileSync('ran.txt', 'hit');\n");
        let s = wsx::open(&dir.to_string_lossy()).unwrap();
        let root = wsx::root_of(&s.id).unwrap();
        let cmd = argv(&["npm", "run", "build"]);
        let marker = dir.join("ran.txt");

        // 被测组：全新会话没有任何授权
        match perms::guard(&s.id, &cmd) {
            Err(perms::GateDenied::NeedGrant { scope, .. }) => {
                assert_eq!(scope, vec!["npm", "run", "build"], "授权粒度必须是命令+子命令");
            }
            other => panic!("新会话必须是 NeedGrant，实际 {other:?}"),
        }
        assert!(!marker.exists(), "闸门拒绝了，但命令还是跑起来了");

        // 对照组：批准之后必须真的能跑，否则上面的「没出现」说明不了任何事
        perms::grant(&s.id, &["npm".into(), "run".into(), "build".into()], None, "build".into());
        assert!(perms::guard(&s.id, &cmd).is_ok());
        let r = runx::run_allowed(&root, &cmd).unwrap();
        assert!(r.exit_code.is_some(), "对照组命令没跑起来：{:?}", r.stderr);
        assert!(marker.exists(), "对照组失效：授权后命令仍然没执行，这条用例证明不了闸门");

        // 撤销之后立刻不能再用
        perms::revoke(&s.id, None);
        assert!(matches!(perms::guard(&s.id, &cmd), Err(perms::GateDenied::NeedGrant { .. })));

        wsx::close(&s.id).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    /// 授权不能覆盖白名单：给一条危险命令批了也没用。
    ///
    /// 这条防的是「审批把白名单架空」——如果 decide 先看授权再看白名单，
    /// 用户一次误点就等于永久开了 `npm install`。
    #[test]
    fn grant_cannot_override_the_allowlist() {
        let s = wsx::open(&std::env::temp_dir().to_string_lossy()).unwrap();
        perms::grant(&s.id, &["npm".into(), "install".into()], None, "install".into());
        perms::grant(&s.id, &["git".into(), "push".into()], None, "push".into());
        match perms::guard(&s.id, &argv(&["npm", "install"])) {
            Err(perms::GateDenied::Refused { reason }) => assert!(reason.contains("npm 只允许"), "{reason}"),
            other => panic!("白名单必须先拒，实际 {other:?}"),
        }
        assert!(matches!(perms::guard(&s.id, &argv(&["git", "push"])), Err(perms::GateDenied::Refused { .. })));
        wsx::close(&s.id).unwrap();
    }

    /// 授权不能跨工程目录继承，也不能在会话关闭后存活。
    ///
    /// 注意一个已知语义（见 wsx::open）：同一个目录重复登记会复用同一个 sessionId，
    /// 所以授权实际是「按工程目录」记账的，不是「按对话」。这是有意的——启动恢复、
    /// 重新选中都幂等。代价是同一目录的多个对话共享授权，因此前端在切换对话时
    /// 会主动调 perm_revoke 把它收回到「当前对话」。
    #[test]
    fn grant_does_not_survive_session_close_or_leak_across_sessions() {
        let dir_a = npm_project("permleak-a", "console.log('a');\n");
        let dir_b = npm_project("permleak-b", "console.log('b');\n");
        let a = wsx::open(&dir_a.to_string_lossy()).unwrap();
        let b = wsx::open(&dir_b.to_string_lossy()).unwrap();
        assert_ne!(a.id, b.id, "不同目录必须是不同会话");

        perms::grant(&a.id, &["git".into(), "status".into()], None, "status".into());
        assert!(perms::guard(&a.id, &argv(&["git", "status"])).is_ok());
        // 另一个工程目录不能沾光
        assert!(matches!(perms::guard(&b.id, &argv(&["git", "status"])), Err(perms::GateDenied::NeedGrant { .. })));

        // 同一目录再 open 会复用同一会话（幂等），授权因此跟着目录走
        let again = wsx::open(&dir_a.to_string_lossy()).unwrap();
        assert_eq!(again.id, a.id, "wsx::open 对同目录是幂等的，这条是授权按目录记账的原因");

        wsx::close(&a.id).unwrap();
        // wsx::close 只关会话；授权清理是 lib.rs 的 ws_close 命令做的。
        // 这里显式走一遍同样的清理，验证清理之后确实失效。
        perms::clear_session(&a.id);
        assert!(matches!(perms::guard(&a.id, &argv(&["git", "status"])), Err(perms::GateDenied::NeedGrant { .. })));
        // 会话已关闭时，连闸门都进不去（root_of 先拒）
        assert!(wsx::root_of(&a.id).is_err());
        wsx::close(&b.id).unwrap();
        let _ = fs::remove_dir_all(&dir_a);
        let _ = fs::remove_dir_all(&dir_b);
    }

    /// 架构约束：生产代码里 `runx::run_allowed` 只能有**一个**调用点，且在闸门之后。
    ///
    /// 这个断言防的是「以后再加一个执行 IPC，顺手直接调了 run_allowed」——
    /// 那种改动编译通过、功能正常、审计时很难注意到，但正好把 exec 默认 ask 绕开了。
    /// 用读源码的方式做检查不算优雅，但它是唯一能在 CI 无 GUI 环境里跑起来的约束。
    #[test]
    fn exec_has_exactly_one_guarded_entry_point() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let lib = fs::read_to_string(root.join("src-tauri/src/lib.rs")).expect("读不到 lib.rs");
        let hits: Vec<usize> = lib.match_indices("crate::runx::run_allowed").map(|(i, _)| i).collect();
        assert_eq!(
            hits.len(),
            1,
            "lib.rs 里 runx::run_allowed 应当只有一个调用点（闸门后面那个），实际 {} 个",
            hits.len()
        );
        let i = hits[0];
        // 按字符边界回退：直接 i-300 可能切在一个多字节汉字中间，panic 起来像测试坏了
        let mut start = i.saturating_sub(300);
        while start > 0 && !lib.is_char_boundary(start) {
            start -= 1;
        }
        let before = &lib[start..i];
        assert!(
            before.contains("gate_exec"),
            "唯一的执行调用点前面没有 gate_exec —— exec 默认 ask 被绕开了"
        );
    }

    /// 相对路径不能当工作目录：cwd 只认会话登记出来的绝对路径
    #[test]
    fn run_allowed_rejects_relative_cwd() {
        assert!(runx::run_allowed(Path::new("relative/nope"), &argv(&["git", "status"])).is_err());
    }
}
