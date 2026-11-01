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
    use super::runx;
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

    /// 相对路径不能当工作目录：cwd 只认会话登记出来的绝对路径
    #[test]
    fn run_allowed_rejects_relative_cwd() {
        assert!(runx::run_allowed(Path::new("relative/nope"), &argv(&["git", "status"])).is_err());
    }
}
