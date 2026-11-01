// 本机文件读写：给「让模型把代码写到本地磁盘」用。
//
// 安全边界（三道）：
// 1) 相对路径只允许普通段，拒绝 `..`、绝对路径、盘符前缀、UNC；
// 2) 工程根目录由 wsx 登记并 canonicalize，这里收到的 root 已经是锁定的真实路径；
// 3) 逐段解析真实落点：符号链接 / junction 借道、悬空链接一律拒绝，
//    包含判定按路径组件比较，不做字符串前缀判断。
//
// 本模块不依赖 tauri：IPC 壳在 lib.rs 里，这样纯逻辑可以在无窗口环境下直接跑单测。
// 读文件有 4MB 上限，非 UTF-8 直接报错（这里只服务文本代码，不做二进制搬运）。
//
// 关于 root：本模块所有工程内函数只接受 `&Path`，且必须是绝对路径。
// 唯一有权把「用户选的目录」变成 root 的地方是 `wsx::open()`；
// 前端永远拿不到、也传不进来第二个 root（见 wsx.rs 与 lib.rs 的 session_id 参数）。

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

#[derive(Debug, Serialize)]
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

/// 组件级包含判定：`F:\proj2` 不是 `F:\proj` 的子目录，字符串前缀会把它误判成工程内。
/// 两侧都要求是 canonicalize 的结果，顺带把大小写、`..`、8.3 短名这些差异归一掉。
pub fn path_inside(root: &Path, p: &Path) -> bool {
    p.starts_with(root)
}

/// Windows 的 junction / 符号链接都是重解析点：Rust 的 `is_symlink()` 认不出 junction，
/// 所以直接看文件属性位，别让 junction 从这道检查里漏过去。
#[cfg(windows)]
fn is_reparse(md: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    md.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
}

#[cfg(not(windows))]
fn is_reparse(_md: &fs::Metadata) -> bool {
    false
}

/// 把相对路径收敛成工程内绝对路径，并挡掉所有借道写法。
///
/// 逐段推进：任何一段只要已经存在（真实目录/文件、符号链接、junction），
/// 就必须能解析、且解析结果仍在工程根内；解析不出来（悬空链接）直接拒绝——
/// 等到真正落盘时才发现写到了工程外就晚了（写会顺着链接落到链接指向的地方）。
///
/// 这一段还不存在的情况（写入时的新建路径）这里无从判断，跳过；
/// 由 write 在建完父目录后再 canonicalize 复核一次落点。
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if !root.is_absolute() {
        return Err("工程根目录必须是绝对路径".into());
    }
    let relp = safe_rel(rel)?;
    let mut cur = root.to_path_buf();
    for seg in relp.components() {
        let Component::Normal(part) = seg else {
            continue; // safe_rel 已保证只剩普通段
        };
        cur.push(part);
        let Ok(md) = fs::symlink_metadata(&cur) else {
            continue; // 这一段还不存在，跳过
        };
        if is_reparse(&md) || md.file_type().is_symlink() {
            match fs::canonicalize(&cur) {
                Ok(real) if path_inside(root, &real) => {}
                Ok(_) => return Err(format!("{rel} 借符号链接/联接点指向工程目录之外，拒绝访问")),
                Err(_) => return Err(format!("{rel} 里有悬空的符号链接/联接点，拒绝访问")),
            }
        } else {
            match fs::canonicalize(&cur) {
                Ok(real) if path_inside(root, &real) => {}
                Ok(_) => return Err(format!("{rel} 越出了工程目录")),
                Err(_) => return Err(format!("{rel} 无法解析：{}", cur.to_string_lossy())),
            }
        }
    }
    Ok(root.join(&relp))
}

pub fn canon_root(root: &str) -> Result<PathBuf, String> {
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

/// 工程内列目录：给模型工具（list_dir / search_files）用。
///
/// `list` 是文件夹选择器的通道，天然要能浏览任意绝对路径；模型侧不能走它——
/// 只要拼一个工程外的绝对路径就绕过了全部相对路径规则。这里和 read/write 一样
/// 收 root+rel，逐段解析后必须仍在工程根内，符号链接/junction 借道也算越界。
pub fn list_in(root: &Path, rel: &str) -> Result<Vec<FsEntry>, String> {
    if root.as_os_str().is_empty() {
        return Err("工程目录为空".into());
    }
    let dir = if rel.trim().is_empty() {
        root.to_path_buf()
    } else {
        resolve(root, rel)?
    };
    let real = fs::canonicalize(&dir).map_err(|e| format!("目录不可用（{rel}）：{e}"))?;
    if !path_inside(root, &real) {
        return Err(format!("{rel} 越出了工程目录"));
    }
    list(real.to_string_lossy().to_string())
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
pub fn strip_verbatim(p: &Path) -> PathBuf {
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

pub fn read(root: &Path, rel: &str) -> Result<String, String> {
    // 边界全在 resolve 里：符号链接/联接点借道、悬空链接、..、绝对路径都在那一步拒绝
    let target = resolve(root, rel)?;
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
pub fn exists(root: &Path, rel: &str) -> Result<bool, String> {
    let target = resolve(root, rel)?;
    Ok(target.exists())
}

pub fn write(root: &Path, rel: &str, content: String) -> Result<WriteResult, String> {
    let target = resolve(root, rel)?;

    if let Some(parent) = target.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("无法创建目录：{e}"))?;
        }
        // 建完（或本来就存在）再复核一次落点：父目录可能刚被换成链接，
        // 也可能 create_dir_all 一路顺着链接建到了工程外。
        let parentc = fs::canonicalize(parent).map_err(|e| format!("父目录不可用：{e}"))?;
        if !path_inside(root, &parentc) {
            return Err(format!("{rel} 越出了工程目录"));
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

    #[cfg(windows)]
    #[test]
    fn read_rejects_junction_escape() {
        // 经 junction 把读请求引到工程外：read 必须像 write 一样守住工程根边界
        let dir = std::env::temp_dir().join(format!("zxz-fsx-readjunction-{}", std::process::id()));
        let outside = std::env::temp_dir().join(format!("zxz-fsx-readout-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "engineer-outside").unwrap();
        let link = dir.join("link");
        fs::create_dir_all(&dir).unwrap();
        let ok = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J", &link.to_string_lossy(), &outside.to_string_lossy()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            let rootc = fs::canonicalize(&dir).unwrap();
            let err = read(&rootc, "link/secret.txt").unwrap_err();
            assert!(err.contains("工程目录之外"), "{err}");
        }
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn exists_reports_presence() {
        let dir = std::env::temp_dir().join(format!("zxz-fsx-exists-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let rootc = fs::canonicalize(&dir).unwrap();
        assert_eq!(exists(&rootc, "a.txt").unwrap(), false);
        fs::write(dir.join("a.txt"), "x").unwrap();
        assert_eq!(exists(&rootc, "a.txt").unwrap(), true);
    }

    #[test]
    fn root_must_be_absolute() {
        assert!(canon_root("relative/dir").is_err());
    }

    #[test]
    fn list_in_stays_inside_root() {
        let dir = std::env::temp_dir().join(format!("zxz-fsx-listin-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src\\lib")).unwrap();
        fs::write(dir.join("src\\lib\\a.ts"), "x").unwrap();
        let rootc = fs::canonicalize(&dir).unwrap();
        // 根目录与合法相对目录能列
        assert!(list_in(&rootc, "").unwrap().iter().any(|e| e.name == "src"));
        assert!(list_in(&rootc, "src").unwrap().iter().any(|e| e.name == "lib"));
        // 绝对路径与 .. 一律拒绝：这条通道的模型只能看工程内
        assert!(list_in(&rootc, "C:/Windows").is_err());
        assert!(list_in(&rootc, "../").is_err());
        assert!(list_in(&rootc, "..").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    /// 建 junction 的辅助：`mklink /J` 不需要管理员权限，符号链接要，所以用例都用它
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
    fn resolve_rejects_traversal_and_absolute() {
        let dir = std::env::temp_dir().join(format!("zxz-fsx-resolve-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let rootc = fs::canonicalize(&dir).unwrap();
        for bad in ["../outside.txt", "a/../../b.txt", "/etc/passwd", "./../../x"] {
            assert!(resolve(&rootc, bad).is_err(), "应拒绝：{bad}");
        }
        // 合法路径要放行，包括还没创建的目标
        let p = resolve(&rootc, "src/lib/a.ts").unwrap();
        assert!(path_inside(&rootc, &p));
        assert!(resolve(&rootc, "").is_err(), "空路径不能通过");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn resolve_rejects_drive_and_unc() {
        // 盘符与 UNC 都是 Component::Prefix，不能在工程内相对路径里出现
        for bad in ["C:\\Windows\\win.ini", "C:relative.txt", r"\\server\share\a.txt"] {
            assert!(safe_rel(bad).is_err(), "应拒绝：{bad}");
        }
    }

    #[test]
    fn write_creates_missing_target_and_parents() {
        // 目标与父目录都不存在：要能安全创建，且落点必须还在工程内
        let dir = std::env::temp_dir().join(format!("zxz-fsx-create-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let rootc = fs::canonicalize(&dir).unwrap();
        let r = write(&rootc, "a/b/c.txt", "hello".into()).unwrap();
        assert!(r.created);
        assert_eq!(fs::read_to_string(dir.join("a/b/c.txt")).unwrap(), "hello");
        assert!(!dir.parent().unwrap().join("c.txt").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn resolve_rejects_junction_escape() {
        // 工程内的 junction 指向工程外：不管读还是写，逐段解析时必须被挡住
        let base = std::env::temp_dir().join(format!("zxz-fsx-resj-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("root")).unwrap();
        let outside = base.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "outside").unwrap();
        let rootc = fs::canonicalize(base.join("root")).unwrap();
        // 建不出来就别假装通过：这条用例必须有真的 junction 才算数
        assert!(mk_junction(&rootc.join("jl"), &outside), "junction 创建失败，用例没有真正验证");
        {
            let e = resolve(&rootc, "jl/secret.txt").unwrap_err();
            assert!(e.contains("工程目录之外"), "{e}");
            assert!(resolve(&rootc, "jl").is_err(), "junction 本身也要拒绝");
            // 写入同样不能借它落到工程外
            assert!(write(&rootc, "jl/x.txt", "x".into()).is_err());
            assert!(!outside.join("x.txt").exists(), "不该写到工程外");
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(windows)]
    #[test]
    fn resolve_rejects_dangling_junction() {
        // 悬空 junction：symlink_metadata 认得出它是重解析点，但 canonicalize 会失败。
        // 旧实现把它当成“不存在”放过去了，写入就会顺着链接落到链接指向的地方。
        let base = std::env::temp_dir().join(format!("zxz-fsx-dangj-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("root")).unwrap();
        let outside = base.join("outside");
        fs::create_dir_all(&outside).unwrap();
        let rootc = fs::canonicalize(base.join("root")).unwrap();
        assert!(mk_junction(&rootc.join("jl"), &outside), "junction 创建失败，用例没有真正验证");
        {
            // 删掉目标 → junction 变悬空：symlink_metadata 仍成功，canonicalize 失败
            fs::remove_dir_all(&outside).unwrap();
            assert!(fs::symlink_metadata(rootc.join("jl")).is_ok(), "悬空 junction 必须还能被 symlink_metadata 认出来");
            assert!(fs::canonicalize(rootc.join("jl")).is_err(), "悬空 junction 解析不了");
            let e = resolve(&rootc, "jl/secret.txt").unwrap_err();
            assert!(e.contains("悬空"), "{e}");
            let e2 = write(&rootc, "jl", "x".into()).unwrap_err();
            assert!(e2.contains("悬空"), "{e2}");
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(windows)]
    #[test]
    fn list_in_rejects_junction_escape() {
        // Windows 用 mklink /J 建 junction（不需要管理员权限），指向工程外
        let dir = std::env::temp_dir().join(format!("zxz-fsx-listjunction-{}", std::process::id()));
        let outside = std::env::temp_dir().join(format!("zxz-fsx-listout-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(dir.join("link")).unwrap();
        fs::remove_dir(dir.join("link")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let outside_src = outside.join("src");
        fs::create_dir_all(&outside_src).unwrap();
        fs::write(outside_src.join("topsecret.txt"), "x").unwrap();
        let target = outside_src.to_string_lossy().to_string();
        let link = dir.join("link").to_string_lossy().to_string();
        let ok = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J", &link, &target])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            let rootc = fs::canonicalize(&dir).unwrap();
            // junction canonicalize 后落到工程外 → 必须拒绝
            assert!(list_in(&rootc, "link").is_err());
        }
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside);
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
