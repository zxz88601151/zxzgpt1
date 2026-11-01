// 受控命令执行：给“工具调用 + 测试回路”用。
//
// 安全边界（与前端 src/lib/tools.ts 的白名单必须保持一致，改一边就要改另一边）：
// 1) 不走 shell：命令以 argv 数组直接交给子进程，不拼字符串，shell 元字符
//    一律拒绝；工作目录只限工程根目录（必须是绝对路径且真实存在）。
// 2) 白名单只放测试、构建、只读 Git：npm test / npm run build / npm run lint、
//    npx vitest run、git status / git diff / git diff --stat，以及 --version 查询。
//    安装、发布、推送、提交、删除、改写历史一律拒绝，不弹确认、直接报错。
// 3) 超时 60 秒：超时杀掉子进程并返回 timed_out，输出不会无限等。
// 4) 输出上限：stdout + stderr 各截断到 20000 字符，超了标 truncated，不把
//    整个测试日志塞回模型上下文。
//
// 本模块不依赖 tauri：IPC 壳在 lib.rs 里，纯逻辑可以在 fs-harness 里直接跑单测
// （见 tools/fs-harness/src/main.rs 的 #[path] 引用，与 fsx.rs 同一套做法）。

use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const RUN_TIMEOUT_SECS: u64 = 60;
const MAX_OUTPUT_CHARS: usize = 20000;

#[derive(Serialize)]
pub struct RunResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub truncated: bool,
}

fn has_shell_meta(arg: &str) -> bool {
    arg.chars().any(|c| matches!(c, ';' | '|' | '&' | '$' | '`' | '<' | '>' | '\0' | '\n' | '\r'))
}

/// 附加参数是不是安全的测试文件过滤词：不以 - 开头、不含 ..、不含 shell 元字符
fn is_safe_filter(arg: &str) -> bool {
    if arg.is_empty() || arg.starts_with('-') {
        return false;
    }
    if has_shell_meta(arg) {
        return false;
    }
    if arg.split('/').any(|seg| seg == ".." || seg.is_empty()) {
        return false;
    }
    true
}

/// 白名单校验：Ok 表示允许，Err 是中文拒绝原因。前端 tools.ts 里有一份镜像逻辑。
pub fn is_allowed(argv: &[String]) -> Result<(), String> {
    if argv.is_empty() {
        return Err("命令为空".into());
    }
    for a in argv {
        if a.is_empty() || a.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
            return Err("命令参数不能为空或含控制字符".into());
        }
    }
    let cmd = argv[0].as_str();
    let rest = &argv[1..];
    match cmd {
        "npm" => {
            if !rest.is_empty() && rest[0] == "test" {
                if rest[1..].iter().all(|a| is_safe_filter(a)) {
                    return Ok(());
                }
                return Err("npm test 只允许附加安全的测试文件过滤词".into());
            }
            if rest.len() == 2 && rest[0] == "run" && (rest[1] == "build" || rest[1] == "lint") {
                return Ok(());
            }
            if rest.len() == 1 && rest[0] == "--version" {
                return Ok(());
            }
            Err("npm 只允许 test、run build、run lint、--version".into())
        }
        "npx" => {
            if rest.len() >= 2 && rest[0] == "vitest" && rest[1] == "run" {
                if rest[2..].iter().all(|a| is_safe_filter(a)) {
                    return Ok(());
                }
                return Err("npx vitest run 只允许附加安全的测试文件过滤词".into());
            }
            Err("npx 只允许 vitest run".into())
        }
        "node" => {
            if rest.len() == 1 && rest[0] == "--version" {
                return Ok(());
            }
            Err("node 只允许 --version".into())
        }
        "git" => {
            if rest.len() == 1 && rest[0] == "status" {
                return Ok(());
            }
            if !rest.is_empty() && rest[0] == "status"
                && rest[1..].iter().all(|a| a == "--short" || a == "--porcelain" || a == "-s")
            {
                return Ok(());
            }
            if rest.len() == 1 && rest[0] == "diff" {
                return Ok(());
            }
            if rest.len() == 2 && rest[0] == "diff" && rest[1] == "--stat" {
                return Ok(());
            }
            if rest.len() == 1 && rest[0] == "--version" {
                return Ok(());
            }
            Err("git 只允许 status、diff、diff --stat、--version".into())
        }
        _ => Err("不在白名单里的命令：只允许 npm、npx、node、git 的测试/构建/只读子命令".into()),
    }
}

fn truncate(s: &str) -> (String, bool) {
    if s.chars().count() <= MAX_OUTPUT_CHARS {
        return (s.to_string(), false);
    }
    let end = s.char_indices().nth(MAX_OUTPUT_CHARS).map(|(i, _)| i).unwrap_or(s.len());
    (s[..end].to_string(), true)
}

/// 在工程根目录执行一条白名单命令。调用前必须先过 is_allowed，这里会再校验一次，
//  绝不信任前端传进来的 argv。
pub fn run_allowed(root: &str, argv: &[String]) -> Result<RunResult, String> {
    is_allowed(argv)?;
    let dir = Path::new(root);
    if !dir.is_absolute() {
        return Err("工程目录必须是绝对路径".into());
    }
    if !dir.is_dir() {
        return Err(format!("工程目录不可用：{root}"));
    }

    let mut child: Child = Command::new(&argv[0])
        .args(&argv[1..])
        .current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动命令失败（{}）：{e}", argv.join(" ")))?;

    // 两个读线程并发排空管道，否则输出一多就会把子进程堵死在管道缓冲区里。
    let stdout_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let mut readers = Vec::new();
    if let Some(mut out) = child.stdout.take() {
        let buf = stdout_buf.clone();
        readers.push(thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                match out.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => buf.lock().unwrap().extend_from_slice(&chunk[..n]),
                    Err(_) => break,
                }
            }
        }));
    }
    if let Some(mut err) = child.stderr.take() {
        let buf = stderr_buf.clone();
        readers.push(thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                match out_read(&mut err, &mut chunk) {
                    Ok(0) => break,
                    Ok(n) => buf.lock().unwrap().extend_from_slice(&chunk[..n]),
                    Err(_) => break,
                }
            }
        }));
    }

    let start = Instant::now();
    let mut timed_out = false;
    let mut status: Option<std::process::ExitStatus> = None;
    loop {
        match child.try_wait().map_err(|e| format!("等待命令失败：{e}"))? {
            Some(s) => {
                status = Some(s);
                break;
            }
            None => {
                if start.elapsed() >= Duration::from_secs(RUN_TIMEOUT_SECS) {
                    let _ = child.kill();
                    timed_out = true;
                    status = child.wait().ok();
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
        }
    }
    for r in readers {
        let _ = r.join();
    }

    let stdout_raw = String::from_utf8_lossy(&stdout_buf.lock().unwrap()).into_owned();
    let stderr_raw = String::from_utf8_lossy(&stderr_buf.lock().unwrap()).into_owned();
    let (stdout, t1) = truncate(&stdout_raw);
    let (stderr, t2) = truncate(&stderr_raw);
    Ok(RunResult {
        exit_code: status.and_then(|s| s.code()),
        stdout,
        stderr,
        timed_out,
        truncated: t1 || t2,
    })
}

fn out_read<R: Read>(r: &mut R, buf: &mut [u8]) -> std::io::Result<usize> {
    r.read(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn allows_test_build_and_readonly_git() {
        assert!(is_allowed(&argv(&["npm", "test"])).is_ok());
        assert!(is_allowed(&argv(&["npm", "test", "src/lib/tools.test.ts"])).is_ok());
        assert!(is_allowed(&argv(&["npm", "run", "build"])).is_ok());
        assert!(is_allowed(&argv(&["npm", "run", "lint"])).is_ok());
        assert!(is_allowed(&argv(&["npx", "vitest", "run"])).is_ok());
        assert!(is_allowed(&argv(&["git", "status"])).is_ok());
        assert!(is_allowed(&argv(&["git", "diff", "--stat"])).is_ok());
    }

    #[test]
    fn rejects_destructive_and_shell_meta() {
        assert!(is_allowed(&argv(&["npm", "install"])).is_err());
        assert!(is_allowed(&argv(&["npm", "publish"])).is_err());
        assert!(is_allowed(&argv(&["git", "push"])).is_err());
        assert!(is_allowed(&argv(&["git", "reset", "--hard"])).is_err());
        assert!(is_allowed(&argv(&["rm", "-rf", "."])).is_err());
        assert!(is_allowed(&argv(&["npm", "test", "a;rm -rf ."])).is_err());
        assert!(is_allowed(&argv(&["npm", "test", "--watch"])).is_err());
        assert!(is_allowed(&argv(&["npm", "test", "../outside"])).is_err());
        assert!(is_allowed(&argv(&[])).is_err());
    }

    #[test]
    fn rejects_relative_root() {
        let r = run_allowed("relative/path", &argv(&["git", "status"]));
        assert!(r.is_err());
    }
}
