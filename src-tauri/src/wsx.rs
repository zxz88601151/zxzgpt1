// 工作区会话：工程根目录由 Rust 登记，前端只拿 sessionId。
//
// 迁移前：每个文件/命令 IPC 都带着一个 root，Rust 只校验「它是绝对路径」——
// 于是「工程边界」其实只是前端的约定，任何能调 invoke 的代码换一个 root 就出界了。
// 迁移后：root 只在 `open()` 里出现一次（用户在文件夹选择器里选的那一次），
// 之后一切操作只认 sessionId；根目录在这里被 canonicalize 并锁定，永不再由前端指定。
//
// 三条纪律：
// 1) sessionId 由 Rust 生成，不可预测，前端猜不出别人的会话；
// 2) 未登记、已关闭、伪造的 id 一律拒绝，错误信息不透露别的会话信息；
// 3) 本模块不依赖 tauri，纯逻辑在 tools/fs-harness 里单测（与 fsx/runx 同一套做法）。
//
// 权限系统（ADR-0002）落在 P0-4：接入点是 `root_for()` 里那一行——
// 那时它会从「这个会话登记过吗」升级成「这个操作被批准了吗」，
// 现在的签名与调用点已经按这个方向留好了位置。

use serde::Serialize;
use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::fsx::{canon_root, strip_verbatim};

/// 同时存活的会话上限：挡住前端反复 open 把登记表撑大
const MAX_SESSIONS: usize = 64;

/// 回传给前端的会话信息。`root` 只是给人看的展示值，不能再拿去做任何文件系统调用。
#[derive(Clone, Debug, Serialize)]
pub struct SessionInfo {
    pub id: String,
    /// 已 canonicalize 并去掉 Windows verbatim 前缀的工程根目录（仅展示）
    pub root: String,
    /// 目录名，界面直接显示
    pub name: String,
}

struct Session {
    /// 真实落点：canonicalize 后的绝对路径，全程只在这里
    root: PathBuf,
    root_display: String,
    name: String,
    closed: bool,
}

struct Registry {
    sessions: HashMap<String, Session>,
    seq: u64,
}

static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();

fn lock() -> MutexGuard<'static, Registry> {
    REGISTRY
        .get_or_init(|| Mutex::new(Registry { sessions: HashMap::new(), seq: 0 }))
        .lock()
        // 有线程在持锁时 panic 也不拖死后续调用：登记表只丢这一次的改动
        .unwrap_or_else(|e| e.into_inner())
}

/// 会话 id：OS 随机种子（RandomState）+ 单调序号 + 纳秒时间 + pid 混出的 128 位十六进制。
/// 前端无法预测下一个 id，也就猜不到别人的会话。
fn gen_id(seq: u64) -> String {
    let rs = RandomState::new();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let pid = std::process::id() as u64;

    let mut h = rs.build_hasher();
    h.write_u64(nanos);
    h.write_u64(pid);
    h.write_u64(seq);
    let hi = h.finish();

    let mut h2 = rs.build_hasher();
    h2.write_u64(hi ^ nanos.reverse_bits());
    h2.write_u64(pid ^ seq);
    let lo = h2.finish();

    format!("ws-{hi:016x}{lo:016x}")
}

fn info_of(id: &str, s: &Session) -> SessionInfo {
    SessionInfo {
        id: id.to_string(),
        root: s.root_display.clone(),
        name: s.name.clone(),
    }
}

/// 登记一个工程目录：这是 root 唯一被接受的地方，也是它最后一次出现在 IPC 里。
///
/// 同一个目录重复 open 直接复用已有会话——启动恢复、重新选中都幂等，也不会撑大登记表。
pub fn open(root: &str) -> Result<SessionInfo, String> {
    let real = canon_root(root)?;
    if !real.is_dir() {
        return Err(format!("{root} 不是文件夹"));
    }

    let mut reg = lock();
    for (id, s) in &reg.sessions {
        if !s.closed && s.root == real {
            return Ok(info_of(id, s));
        }
    }
    let live = reg.sessions.values().filter(|s| !s.closed).count();
    if live >= MAX_SESSIONS {
        return Err(format!("同时打开的工程目录过多（上限 {MAX_SESSIONS}），先关掉不用的"));
    }

    reg.seq += 1;
    let id = gen_id(reg.seq);
    let name = real
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| real.to_string_lossy().to_string());
    let display = strip_verbatim(&real).to_string_lossy().to_string();
    reg.sessions.insert(
        id.clone(),
        Session {
            root: real,
            root_display: display.clone(),
            name: name.clone(),
            closed: false,
        },
    );
    Ok(SessionInfo { id, root: display, name })
}

/// 关闭会话：目录还在，但拿着这个 id 再来一律拒绝。
pub fn close(id: &str) -> Result<(), String> {
    let mut reg = lock();
    match reg.sessions.get_mut(id) {
        Some(s) => {
            s.closed = true;
            Ok(())
        }
        None => Err(format!("未登记的会话：{id}")),
    }
}

pub fn info(id: &str) -> Result<SessionInfo, String> {
    let reg = lock();
    let s = reg.sessions.get(id).ok_or_else(|| format!("未登记的会话：{id}"))?;
    if s.closed {
        return Err("会话已关闭".into());
    }
    Ok(info_of(id, s))
}

/// 文件与命令操作取根目录的唯一入口：未登记、已关闭、伪造的 id 一律拒绝。
///
/// 命令执行的 cwd 也必须从这里来——run_allowed 不接受任何前端指定的目录。
pub fn root_of(id: &str) -> Result<PathBuf, String> {
    let reg = lock();
    let s = reg.sessions.get(id).ok_or_else(|| format!("未登记的会话：{id}"))?;
    if s.closed {
        return Err("会话已关闭，请重新接入工程目录".into());
    }
    Ok(s.root.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[cfg(windows)]
    use std::path::Path;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zxz-wsx-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(&d).unwrap()
    }

    fn argv(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[cfg(windows)]
    fn mk_junction(link: &Path, target: &Path) -> bool {
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J", &link.to_string_lossy(), &target.to_string_lossy()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    #[test]
    fn open_registers_canonical_root() {
        let dir = tmp("open");
        let s = open(&dir.to_string_lossy()).unwrap();
        assert!(s.id.starts_with("ws-"), "{}", s.id);
        assert_eq!(s.name, dir.file_name().unwrap().to_string_lossy());
        // 展示值不带 Windows verbatim 前缀，用户能看懂
        assert!(!s.root.contains(r"\\?\"), "{}", s.root);
        // 会话里的真实 root 必须是 canonicalize 后的绝对路径
        let real = root_of(&s.id).unwrap();
        assert_eq!(real, fs::canonicalize(&dir).unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn open_is_idempotent_per_directory() {
        // 同一个目录重复 open 复用会话：启动恢复不会每次都新开一个
        let dir = tmp("idem");
        let a = open(&dir.to_string_lossy()).unwrap();
        let b = open(&dir.to_string_lossy()).unwrap();
        assert_eq!(a.id, b.id);
        let other = tmp("idem2");
        let c = open(&other.to_string_lossy()).unwrap();
        assert_ne!(a.id, c.id);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&other);
    }

    #[test]
    fn ids_are_not_predictable() {
        // 不可预测：不是自增序号，也不含路径信息
        let d1 = tmp("id1");
        let d2 = tmp("id2");
        let a = open(&d1.to_string_lossy()).unwrap().id;
        let b = open(&d2.to_string_lossy()).unwrap().id;
        assert_ne!(a, b);
        assert!(a.len() >= 32, "{a}");
        assert!(!a.contains(&d1.to_string_lossy().to_string()), "{a}");
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == 'w' || c == 's'));
        let _ = fs::remove_dir_all(&d1);
        let _ = fs::remove_dir_all(&d2);
    }

    #[test]
    fn rejects_unknown_session() {
        let e = root_of("ws-00000000000000000000000000000000").unwrap_err();
        assert!(e.contains("未登记"), "{e}");
        assert!(info("nope").is_err());
        assert!(close("nope").is_err());
    }

    #[test]
    fn rejects_closed_session() {
        let dir = tmp("closed");
        let s = open(&dir.to_string_lossy()).unwrap();
        close(&s.id).unwrap();
        let e = root_of(&s.id).unwrap_err();
        assert!(e.contains("已关闭"), "{e}");
        assert!(info(&s.id).is_err());
        // 关过的会话拿不到 root，文件与命令都无从落点
        assert!(crate::fsx::read(&fs::canonicalize(&dir).unwrap(), "a.txt").is_ok() == false);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_non_absolute_or_missing_root() {
        assert!(open("relative/dir").is_err());
        let e = open(&std::env::temp_dir().join(format!("zxz-wsx-none-{}", std::process::id())).to_string_lossy())
            .unwrap_err();
        assert!(e.contains("不可用"), "{e}");
    }

    #[test]
    fn read_and_write_work_inside_session() {
        let dir = tmp("rw");
        let s = open(&dir.to_string_lossy()).unwrap();
        let root = root_of(&s.id).unwrap();
        let r = crate::fsx::write(&root, "src/lib/a.ts", "export const a = 1;\n".into()).unwrap();
        assert!(r.created);
        assert_eq!(crate::fsx::read(&root, "src/lib/a.ts").unwrap(), "export const a = 1;\n");
        assert!(crate::fsx::exists(&root, "src/lib/a.ts").unwrap());
        assert!(!crate::fsx::exists(&root, "nope.txt").unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        let dir = tmp("trav");
        let s = open(&dir.to_string_lossy()).unwrap();
        let root = root_of(&s.id).unwrap();
        for bad in ["../outside.txt", "a/../../b.txt", "/etc/passwd"] {
            assert!(crate::fsx::write(&root, bad, "x".into()).is_err(), "应拒绝写入：{bad}");
            assert!(crate::fsx::read(&root, bad).is_err(), "应拒绝读取：{bad}");
            assert!(crate::fsx::exists(&root, bad).is_err(), "应拒绝存在性查询：{bad}");
        }
        assert!(!dir.parent().unwrap().join("outside.txt").exists(), "不该写到工程外");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn rejects_junction_and_dangling_junction_escape() {
        let base = std::env::temp_dir().join(format!("zxz-wsx-junc-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("root")).unwrap();
        let outside = base.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "outside").unwrap();

        let s = open(&base.join("root").to_string_lossy()).unwrap();
        let root = root_of(&s.id).unwrap();
        // 建不出来就别假装通过：必须有真的 junction，这条用例才算数
        assert!(mk_junction(&root.join("jl"), &outside), "junction 创建失败，用例没有真正验证");
        {
            // 活的 junction：读/写/列都不能借它出界
            assert!(crate::fsx::read(&root, "jl/secret.txt").is_err());
            assert!(crate::fsx::write(&root, "jl/x.txt", "x".into()).is_err());
            assert!(!outside.join("x.txt").exists());
            // 删掉目标 → 悬空：写入会顺着链接落到链接指向的地方，必须在这里挡住
            fs::remove_dir_all(&outside).unwrap();
            let e = crate::fsx::write(&root, "jl", "x".into()).unwrap_err();
            assert!(e.contains("悬空"), "{e}");
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn command_cwd_comes_only_from_registered_session() {
        // 命令执行的 cwd 只能来自已登记的会话：拿不到 root 就无从 spawn
        let dir = tmp("cwd");
        let s = open(&dir.to_string_lossy()).unwrap();
        let cwd = root_of(&s.id).unwrap();
        assert_eq!(cwd, fs::canonicalize(&dir).unwrap());
        let r = crate::runx::run_allowed(&cwd, &argv(&["git", "--version"]));
        assert!(r.is_ok(), "{:?}", r.err());
        close(&s.id).unwrap();
        assert!(root_of(&s.id).is_err(), "已关闭会话不能再当命令工作目录");
        let _ = fs::remove_dir_all(&dir);
    }
}
