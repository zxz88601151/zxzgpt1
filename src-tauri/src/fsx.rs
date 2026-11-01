// 本机文件读写：给「让模型把代码写到本地磁盘」用。
//
// 安全边界（三道）：
// 1) 相对路径只允许普通段，拒绝 `..`、绝对路径、盘符前缀；
// 2) 工程根目录必须是绝对路径且真实存在；
// 3) 真正落盘前对父目录做 canonicalize，确认没借符号链接/软链接逃出工程根目录。
//
// 本模块不依赖 tauri：IPC 壳在 lib.rs 里，这样纯逻辑可以在无窗口环境下直接跑单测。
// 读文件有 4MB 上限，非 UTF-8 直接报错（这里只服务文本代码，不做二进制搬运）。

use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

const MAX_READ: u64 = 4 * 1024 * 1024;
const MAX_ENTRIES: usize = 2000;

#[derive(Serialize)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    pub size: u64,
}

#[derive(Serialize)]
pub struct WriteResult {
    pub path: String,
    pub bytes: usize,
    /// true = 新建，false = 覆盖已有文件
    pub created: bool,
}

/// 把用户/模型给的相对路径收敛成安全路径
fn safe_rel(rel: &str) -> Result<PathBuf, String> {
    let raw = Path::new(rel);
    if raw.is_absolute() {
        return Err(format!("不允许绝对路径：{rel}"));
    }
    let mut out = PathBuf::new();
    for comp in raw.components() {
        match comp {
            Component::Normal(seg) => out.push(seg),
            Component::CurDir => {}
            Component::ParentDir => return Err(format!("路径里不允许出现 ..：{rel}")),
            Component::RootDir | Component::Prefix(_) => return Err(format!("路径里不允许出现盘符/根：{rel}")),
        }
    }
    if out.as_os_str().is_empty() {
        return Err("路径为空".into());
    }
    Ok(out)
}

fn canon_root(root: &str) -> Result<PathBuf, String> {
    let p = Path::new(root);
    if !p.is_absolute() {
        return Err("工程目录必须是绝对路径".into());
    }
    fs::canonicalize(p).map_err(|e| format!("工程目录不可用（{root}）：{e}"))
}

/// 可用盘符（Windows）或 `/`（类 Unix）
pub fn roots() -> Vec<String> {
    #[cfg(windows)]
    {
        let mut out = Vec::new();
        for c in b'A'..=b'Z' {
            let drive = format!("{}:\\", c as char);
            if Path::new(&drive).exists() {
                out.push(drive);
            }
        }
        out
    }
    #[cfg(not(windows))]
    {
        vec!["/".to_string()]
    }
}

/// 列目录：只返回一层，目录在前，按名字排序
pub fn list(path: String) -> Result<Vec<FsEntry>, String> {
    let dir = Path::new(&path);
    if !dir.is_absolute() {
        return Err("必须是绝对路径".into());
    }
    let rd = fs::read_dir(dir).map_err(|e| format!("无法读取目录（{path}）：{e}"))?;

    let mut out: Vec<FsEntry> = Vec::new();
    for ent in rd.flatten() {
        if out.len() >= MAX_ENTRIES {
            break;
        }
        let p = ent.path();
        let name = ent.file_name().to_string_lossy().to_string();
        let md = match ent.metadata() {
            Ok(m) => m,
            Err(_) => continue, // 权限不足之类的条目直接跳过
        };
        out.push(FsEntry {
            name,
            path: p.to_string_lossy().to_string(),
            dir: md.is_dir(),
            size: if md.is_dir() { 0 } else { md.len() },
        });
    }
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

/// 校验「新建文件夹」的名字：必须是单个普通段，且不含系统不允许的字符。
///
/// 这一步只判名字本身，落点由调用方拼在已 canonicalize 的上级目录下，
/// 所以不存在借 `..` 或分隔符跑到别处去的可能。
fn check_dir_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("文件夹名不能为空".into());
    }
    if name != name.trim() {
        return Err("文件夹名首尾不能有空格".into());
    }
    // 单个普通段：挡住 a/b、a\b、..、C: 这些写法
    let p = Path::new(name);
    let mut comps = p.components();
    match (comps.next(), comps.next()) {
        (Some(Component::Normal(seg)), None) if seg == p.as_os_str() => {}
        _ => return Err(format!("文件夹名不能包含路径分隔符，也不能是 . 或 ..：{name}")),
    }

    #[cfg(windows)]
    {
        const ILLEGAL: [char; 7] = ['<', '>', ':', '"', '|', '?', '*'];
        if let Some(c) = name.chars().find(|c| ILLEGAL.contains(c) || (*c as u32) < 0x20) {
            return Err(format!("文件夹名里不能有字符「{c}」：{name}"));
        }
        if name.ends_with('.') {
            return Err("文件夹名不能以点结尾，Windows 会自动去掉那个点".into());
        }
        let base = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
        let reserved = [
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
            "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ];
        if reserved.contains(&base.as_str()) {
            return Err(format!("「{name}」是 Windows 保留名，换一个"));
        }
    }
    #[cfg(not(windows))]
    {
        if name.contains('\0') {
            return Err("文件夹名不能包含空字符".into());
        }
    }
    Ok(())
}

/// 在 `dir` 下新建一层文件夹，返回新目录的绝对路径。
///
/// 只建一层：不做 `create_dir_all`，这样「新建工作区」永远只产生用户看到的那个目录。
/// 已存在时直接报错，不静默复用——否则用户会以为新建成功，实际选中的是旧目录。
/// 去掉 Windows `canonicalize` 加上的 verbatim 前缀。
///
/// `\\?\F:\proj\new` 这种路径在 Rust 里最安全（绕过 MAX_PATH 与名字解析），
/// 但它是**内部**表示：回传给界面就变成用户看不懂的一串，前后端再拿它做字符串
/// 比较也容易对不上。校验继续用 canonicalize 的结果，只把「给人看的那份」还原。
fn strip_verbatim(p: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    p.to_path_buf()
}

pub fn mkdir(dir: String, name: String) -> Result<String, String> {
    let parent = Path::new(&dir);
    if !parent.is_absolute() {
        return Err("上级目录必须是绝对路径".into());
    }
    let parentc = fs::canonicalize(parent).map_err(|e| format!("上级目录不可用（{dir}）：{e}"))?;
    if !parentc.is_dir() {
        return Err(format!("{dir} 不是文件夹"));
    }
    check_dir_name(&name)?;

    let target = parentc.join(&name);
    if target.exists() {
        return Err(format!("「{name}」已存在，换个名字或直接点进去"));
    }
    fs::create_dir(&target).map_err(|e| format!("新建文件夹失败（{name}）：{e}"))?;
    Ok(strip_verbatim(&parentc).join(&name).to_string_lossy().to_string())
}

pub fn read(root: String, rel: String) -> Result<String, String> {
    let rootc = canon_root(&root)?;
    let target = rootc.join(safe_rel(&rel)?);
    let md = fs::metadata(&target).map_err(|e| format!("读取失败（{rel}）：{e}"))?;
    if md.is_dir() {
        return Err(format!("{rel} 是目录，不是文件"));
    }
    if md.len() > MAX_READ {
        return Err(format!("{rel} 超过 4MB，拒绝读取"));
    }
    fs::read_to_string(&target).map_err(|e| format!("{rel} 不是可读的文本文件：{e}"))
}

/// 目标文件是否已存在（写入前的覆盖提示用；不读内容，超大/二进制也不受影响）
pub fn exists(root: String, rel: String) -> Result<bool, String> {
    let rootc = canon_root(&root)?;
    let target = rootc.join(safe_rel(&rel)?);
    Ok(target.exists())
}

pub fn write(root: String, rel: String, content: String) -> Result<WriteResult, String> {
    let rootc = canon_root(&root)?;
    let relp = safe_rel(&rel)?;
    let target = rootc.join(&relp);

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建目录：{e}"))?;
        let parentc = fs::canonicalize(parent).map_err(|e| format!("父目录不可用：{e}"))?;
        if !parentc.starts_with(&rootc) {
            return Err(format!("{rel} 越出了工程目录"));
        }
    }

    // 目标若已存在且是符号链接，要确认它指向的仍在工程内
    if target.exists() {
        if let Ok(real) = fs::canonicalize(&target) {
            if !real.starts_with(&rootc) {
                return Err(format!("{rel} 指向工程目录之外，拒绝写入"));
            }
        }
    }

    let created = !target.exists();
    fs::write(&target, content.as_bytes()).map_err(|e| format!("写入失败（{rel}）：{e}"))?;
    Ok(WriteResult {
        path: target.to_string_lossy().to_string(),
        bytes: content.len(),
        created,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rel_accepts_nested() {
        let p = safe_rel("src/components/App.tsx").unwrap();
        assert_eq!(p, PathBuf::from("src").join("components").join("App.tsx"));
    }

    #[test]
    fn rel_strips_cur_dir() {
        assert_eq!(safe_rel("./a/b.txt").unwrap(), PathBuf::from("a").join("b.txt"));
    }

    #[test]
    fn rel_rejects_escape() {
        assert!(safe_rel("../etc/passwd").is_err());
        assert!(safe_rel("a/../../b").is_err());
    }

    #[test]
    fn rel_rejects_absolute() {
        assert!(safe_rel("/etc/passwd").is_err());
        #[cfg(windows)]
        assert!(safe_rel("C:\\Windows\\win.ini").is_err());
    }

    #[test]
    fn rel_rejects_empty() {
        assert!(safe_rel("").is_err());
        assert!(safe_rel(".").is_err());
    }

    #[test]
    fn exists_reports_presence() {
        let dir = std::env::temp_dir().join(format!("zxz-fsx-exists-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();
        assert_eq!(exists(root.clone(), "a.txt".into()).unwrap(), false);
        fs::write(dir.join("a.txt"), "x").unwrap();
        assert_eq!(exists(root, "a.txt".into()).unwrap(), true);
    }

    #[test]
    fn root_must_be_absolute() {
        assert!(canon_root("relative/dir").is_err());
    }

    #[test]
    fn mkdir_creates_one_level() {
        let base = std::env::temp_dir().join(format!("zxz-fsx-mkdir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let p = mkdir(base.to_string_lossy().to_string(), "workspace".into()).unwrap();
        assert!(Path::new(&p).is_dir());
        assert_eq!(Path::new(&p).file_name().unwrap(), "workspace");
        // 落点必须是上级目录的直接子项（回传值已去掉 verbatim 前缀，比较前先归一化）
        assert_eq!(
            fs::canonicalize(Path::new(&p).parent().unwrap()).unwrap(),
            fs::canonicalize(&base).unwrap()
        );
    }

    #[test]
    fn mkdir_refuses_existing() {
        let base = std::env::temp_dir().join(format!("zxz-fsx-mkdir-exist-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("dup")).unwrap();
        let err = mkdir(base.to_string_lossy().to_string(), "dup".into()).unwrap_err();
        assert!(err.contains("已存在"), "{err}");
    }

    #[test]
    fn mkdir_rejects_bad_names() {
        let base = std::env::temp_dir().join(format!("zxz-fsx-mkdir-bad-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let b = base.to_string_lossy().to_string();
        for bad in ["", "  ", " a", "a ", ".", "..", "a/b", "a\\b"] {
            assert!(mkdir(b.clone(), bad.into()).is_err(), "应拒绝：{bad:?}");
        }
        #[cfg(windows)]
        for bad in ["a:b", "a?b", "con", "NUL.txt", "dot."] {
            assert!(mkdir(b.clone(), bad.into()).is_err(), "应拒绝：{bad:?}");
        }
        // 合法但带中文/空格的名字要能建
        assert!(mkdir(b, "我的 工程".into()).is_ok());
    }

    #[test]
    fn mkdir_needs_existing_parent() {
        let base = std::env::temp_dir().join(format!("zxz-fsx-mkdir-nop-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let missing = base.join("nope").to_string_lossy().to_string();
        assert!(mkdir(missing, "x".into()).is_err());
        assert!(mkdir("relative".into(), "x".into()).is_err());
    }

    /// 回传给界面的路径不能再带 `\\?\`：用户看不懂，前端拿它做字符串比较也会对不上。
    #[test]
    fn mkdir_returns_plain_path() {
        let base = std::env::temp_dir().join(format!("zxz-fsx-mkdir-plain-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let made = mkdir(base.to_string_lossy().to_string(), "visible".into()).unwrap();
        assert!(!made.contains(r"\\?\"), "{}", made);
        assert!(made.ends_with("visible"), "{}", made);
        assert!(Path::new(&made).is_dir(), "{}", made);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn verbatim_prefix_is_stripped() {
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\F:\zhuomian\zxz")),
            PathBuf::from(r"F:\zhuomian\zxz")
        );
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\UNC\server\share")),
            PathBuf::from(r"\\server\share")
        );
        let plain = Path::new(r"F:\zhuomian\zxz");
        assert_eq!(strip_verbatim(plain), plain);
    }
}
