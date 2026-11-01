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

fn main() {
    let dir = std::env::args().nth(1).unwrap_or_else(|| std::env::temp_dir().to_string_lossy().to_string());
    println!("roots = {:?}", fsx::roots());
    println!("list  = {:?}", fsx::list(dir.clone()).map(|v| v.len()));
}

#[cfg(test)]
mod tests {
    use super::fsx;
    use std::fs;
    use std::path::PathBuf;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zxz-fsx-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn writes_and_creates_parents() {
        let root = tmp("write");
        let r = fsx::write(
            root.to_string_lossy().to_string(),
            "src/lib/a.ts".into(),
            "export const a = 1;\n".into(),
        )
        .unwrap();
        assert!(r.created);
        assert_eq!(fs::read_to_string(root.join("src/lib/a.ts")).unwrap(), "export const a = 1;\n");
    }

    #[test]
    fn overwrite_reports_not_created() {
        let root = tmp("overwrite");
        let root_s = root.to_string_lossy().to_string();
        fsx::write(root_s.clone(), "a.txt".into(), "v1".into()).unwrap();
        let r = fsx::write(root_s, "a.txt".into(), "v2".into()).unwrap();
        assert!(!r.created);
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "v2");
    }

    #[test]
    fn read_round_trip() {
        let root = tmp("read");
        let root_s = root.to_string_lossy().to_string();
        fsx::write(root_s.clone(), "docs/readme.md".into(), "# hi 你好".into()).unwrap();
        assert_eq!(fsx::read(root_s, "docs/readme.md".into()).unwrap(), "# hi 你好");
    }

    #[test]
    fn rejects_escape_at_runtime() {
        let root = tmp("escape");
        let root_s = root.to_string_lossy().to_string();
        assert!(fsx::write(root_s.clone(), "../outside.txt".into(), "x".into()).is_err());
        assert!(fsx::read(root_s, "../outside.txt".into()).is_err());
        // 确认真的没写出去
        assert!(!root.parent().unwrap().join("outside.txt").exists());
    }

    #[test]
    fn rejects_read_of_missing() {
        let root = tmp("missing");
        assert!(fsx::read(root.to_string_lossy().to_string(), "nope.txt".into()).is_err());
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

#[cfg(test)]
mod runx_tests {
    use super::runx;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{Duration, Instant};

    fn argv(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// 铺一个最小 npm 工程：`npm run build` 是白名单命令，用它把各种子进程行为
    /// （非零退出、超大输出、跑不完）引出来。scripts.build 固定指向 node emit.js，
    /// 于是每种场景只需要换 emit.js 的内容，不用在 JSON 里叠引号转义。
    fn npm_project(tag: &str, emit_js: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zxz-runx-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        const PKG: &str = r#"{"name":"zxz-runx-fixture","version":"1.0.0","private":true,"scripts":{"build":"node emit.js"}}"#;
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
        let dir = std::env::temp_dir().join(format!("zxz-runx-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let r = runx::run_allowed(&dir.to_string_lossy(), &argv(&["git", "status"])).unwrap();
        assert!(!r.timed_out);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nonzero_exit_code_reaches_the_test_loop() {
        // 自动测试回路靠退出码判断「测试过没过」，这条要是掉了，模型会被误判为已通过。
        let dir = npm_project(
            "exit",
            "console.log('boom-stdout');\nconsole.error('boom-stderr');\nprocess.exit(3);\n",
        );
        let r = runx::run_allowed(&dir.to_string_lossy(), &argv(&["npm", "run", "build"])).unwrap();
        assert!(!r.timed_out, "退出码用例不该触发超时");
        assert_eq!(
            r.exit_code,
            Some(3),
            "退出码必须原样透传，stdout={:?} stderr={:?}",
            r.stdout.chars().take(120).collect::<String>(),
            r.stderr.chars().take(120).collect::<String>()
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn truncates_huge_output_and_does_not_deadlock() {
        // 双线程排空管道 + 20000 字符截断：两个流都给到远超管道缓冲区的量，
        // 看会不会卡死（卡死就是 read 线程被管道缓冲堵住没人排空的经典 bug）。
        let dir = npm_project(
            "bigout",
            "process.stdout.write('O'.repeat(300000) + '\\n');\nprocess.stderr.write('E'.repeat(300000) + '\\n');\n",
        );
        let t0 = Instant::now();
        let r = runx::run_allowed(&dir.to_string_lossy(), &argv(&["npm", "run", "build"])).unwrap();
        let spent = t0.elapsed();
        let _ = fs::remove_dir_all(&dir);

        assert!(spent < Duration::from_secs(45), "60 万字符输出花了 {spent:?}，疑似管道堵死");
        assert!(r.truncated, "超长输出必须标记 truncated");
        assert_eq!(r.stdout.chars().count(), 20000, "stdout 截断不到位");
        assert_eq!(r.stderr.chars().count(), 20000, "stderr 截断不到位");
    }

    /// 超时分支要真跑 60 秒，日常 `cargo test` 不划算，所以默认跳过：
    /// cargo test -- --ignored 才会跑。
    #[test]
    #[ignore = "要实打实等 60 秒超时，按需跑：cargo test -- --ignored"]
    fn timeout_kills_the_child_and_reports_it() {
        // emit.js 先写下自己的 pid，再比超时时间多睡一半：如果 kill 没起作用，
        // finished.txt 会在 run_allowed 返回之后才出现，据此判断子进程死没死透。
        let dir = npm_project(
            "timeout",
            "require('fs').writeFileSync('alive.txt', String(process.pid));\n\
             setTimeout(function () { require('fs').writeFileSync('finished.txt', 'done'); }, 95000);\n",
        );
        let t0 = Instant::now();
        let r = runx::run_allowed(&dir.to_string_lossy(), &argv(&["npm", "run", "build"])).unwrap();
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

    /// Windows 上查某个 pid 还在不在（超时用例用来观察进程树有没有漏杀）
    fn pid_alive(pid: u32) -> bool {
        let Ok(o) = Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output() else {
            return false;
        };
        String::from_utf8_lossy(&o.stdout).contains(&pid.to_string())
    }
}
