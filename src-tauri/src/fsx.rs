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
    if !rel.trim().is_empty() {
        let relp = safe_rel(rel)?;
        // 与 read 同理：快照区的目录结构会泄漏「什么时候改过哪些文件」
        if is_undo_area(&relp) {
            return Err(format!("{rel} 在撤销快照区：只能通过撤销面板查看历史版本"));
        }
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
    let relp = safe_rel(rel)?;
    // 快照区存的是「用户改掉或删掉的旧内容」，当前文件里可能已经看不到的密钥
    // 恰恰只在那里。模型能读 = 一条绕过当前状态的读通道，所以这里关掉，
    // 改走 undo_read（只有撤销面板用）。
    if is_undo_area(&relp) {
        return Err(format!("{rel} 在撤销快照区：只能通过撤销面板查看历史版本"));
    }
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

/// 决定「工具链跑什么、用什么跑」的配置文件。
///
/// `.npmrc` 的 `script-shell` 会整个替换 npm 执行脚本用的 shell——实测有效：
/// 把它指到一个不存在的路径，`npm run build` 直接 `spawn ENOENT`。也就是说
/// 模型写一个自己的批处理、再把它设成 script-shell，此后任何一次「npm test」
/// 跑的都是模型给的程序。`registry`、`ignore-scripts`、`yes` 同样改变行为。
/// 模型改这些没有正当用途，整类拒绝。
fn is_toolchain_config(name: &str) -> bool {
    [".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs"]
        .iter()
        .any(|n| name.eq_ignore_ascii_case(n))
}

/// 受保护目录：程序自己的内部资产，模型与普通写通道一律不可写。
///
/// - `.git/**`：这些路径一旦被改写，git 的行为就被改写了（`.git/config` 的
///   `core.fsmonitor`、`diff.*.textconv`，`.git/hooks/*`，`.git/info/attributes`），
///   而 `run_command` 恰恰允许只读 git。「模型能写 .git」+「git 会执行配置里的命令」
///   = 受控执行变成任意执行。整目录拒绝，不做「只挡 config」这种半开的口子。
/// - `.zxz/undo/**`：撤销快照是覆盖写失败时唯一的安全网。它能被写入 = 这张网可以被
///   改写，用户点「恢复」拿到的就是模型准备好的内容。快照只能经 `undo_write` 落盘。
/// - `.zxz` 本身：它只能是目录。新工程里 `.zxz` 尚不存在时，模型可以把它写成一个
///   普通文件；此后 `undo_write` 的 create_dir_all 永远失败，所有「覆盖已有文件」
///   都会因「备份失败必须中止」而中止——一次自伤式拒绝服务。
/// - 工具链配置：见 `is_toolchain_config`。
///
/// 判定必须基于 **safe_rel 之后** 的路径：`.` 段会被 safe_rel 吃掉，所以
/// `./.git/config` 的字符串首段是 `.` 而不是 `.git`——基于原始字符串判定会放行，
/// 而实际落点就是 `<root>/.git/config`。这个绕过真实存在过（见 dot_prefix 用例）。
fn protected_area(relp: &Path) -> Option<&'static str> {
    let mut segs = relp.components().filter_map(|c| match c {
        Component::Normal(s) => s.to_str(),
        _ => None,
    });
    let first = segs.next()?;
    if first.eq_ignore_ascii_case(".git") {
        return Some(".git");
    }
    if is_toolchain_config(first) {
        return Some("工具链执行配置");
    }
    if first.eq_ignore_ascii_case(".zxz") {
        // `.zxz/` 下只有 undo 是安全资产；`.zxz/audit` 是模型自己产的报告，不挡。
        return match segs.next() {
            None => Some(".zxz"),
            Some(second) if second.eq_ignore_ascii_case("undo") => Some(".zxz/undo"),
            Some(_) => None,
        };
    }
    None
}

/// 撤销快照区：读也走专用通道（`undo_read` / `undo_list`），不走通用 `read`/`list_in`。
///
/// 快照里存的是「用户改掉或删掉的旧内容」——从 `.env`、config 里移除的密钥正确实
/// 只在这一份里存在。模型在**当前**文件里读不到，却能靠 `read_file(".zxz/undo/...")`
/// 读到，还能用 `list_dir` 拿到「用户什么时候改过哪些文件」的轨迹。所以这条通道
/// 对模型关闭，只留给撤销面板。
fn is_undo_area(relp: &Path) -> bool {
    protected_area(relp) == Some(".zxz/undo")
}

pub fn write(root: &Path, rel: &str, content: String) -> Result<WriteResult, String> {
    let relp = safe_rel(rel)?;
    if let Some(area) = protected_area(&relp) {
        return Err(format!("{rel} 落在 {area} 目录内：程序内部资产不允许经写文件通道改动"));
    }
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
        // 再用**真实落点**复核一次保护判定。字符串层的首段比较挡不住 8.3 短名：
        // `ZXZ~1` 在字符串上不等于 `.zxz`，canonicalize 之后才是同一个目录
        // （本机 NTFS 没给这些目录生成短名，实测解析不到，但别的机器/别的卷会）。
        // 判定的对象应该是「实际会写进哪个目录」，不是「输入长什么样」。
        if let Ok(rel_parent) = parentc.strip_prefix(root) {
            if let Some(area) = protected_area(rel_parent) {
                return Err(format!("{rel} 实际落在 {area} 目录内：程序内部资产不允许经写文件通道改动"));
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

/// 快照标识的合法形状：`2026-11-01T02-49-32`（19 字符，秒级）或
/// `2026-11-01T02-49-32-123`（23 字符，毫秒级）。
///
/// 严格到位是刻意的：这个值是撤销通道唯一由外部传入的「目录名」，
/// 只要放过一个 `/` 或 `..`，整条通道就又变回任意路径写入。
///
/// 支持毫秒是因为秒级精度会撞车：同一秒内对同一文件备份两次（一轮里两次
/// write_file，或写完立刻恢复），第二次会覆盖第一次的快照目录，最初的原始版本
/// 就被悄悄顶掉了，而界面仍显示「已备份」。
fn valid_stamp(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 19 && b.len() != 23 {
        return false;
    }
    const DIGITS: [usize; 14] = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18];
    if !DIGITS.iter().all(|&i| b[i].is_ascii_digit()) {
        return false;
    }
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b'-' || b[16] != b'-' {
        return false;
    }
    if b.len() == 23 {
        // `-123`：分隔符 + 三位毫秒
        return b[19] == b'-' && b[20].is_ascii_digit() && b[21].is_ascii_digit() && b[22].is_ascii_digit();
    }
    true
}

/// 撤销快照专用写入通道：模型侧工具够不到它，通用写通道又拒绝 `.zxz/undo`，
/// 于是「谁能写快照」被收敛成「谁持有这条 IPC」——而它不在工具清单里。
///
/// 纵深防御不止于「换一个命令名」：
/// 1) stamp 必须是严格时间戳，堵掉用 `/`、`..` 把目录名变成路径；
/// 2) rel 走 safe_rel，且不得再落进受保护目录（快照里套快照没有意义，只会自我覆盖）；
/// 3) 落点用 canonicalize 复核两次——`undo` 目录本身必须真在工程内，
///    父目录必须真在 `undo/<stamp>` 之下。这样即使 `.zxz/undo` 被人换成指向
///    `src/` 的 junction，写入也不会顺着链接落到源码上。
pub fn undo_write(root: &Path, stamp: &str, rel: &str, content: String) -> Result<WriteResult, String> {
    if !valid_stamp(stamp) {
        return Err(format!("快照标识不合法（要求形如 2026-11-01T02-49-32）：{stamp}"));
    }
    let relp = safe_rel(rel)?;
    if let Some(area) = protected_area(&relp) {
        return Err(format!("{rel} 落在 {area} 内：快照里不能再放快照"));
    }
    if !root.is_absolute() {
        return Err("工程根目录必须是绝对路径".into());
    }

    let undo_root = root.join(".zxz").join("undo");
    fs::create_dir_all(&undo_root).map_err(|e| format!("无法创建撤销目录：{e}"))?;
    let undo_canon = fs::canonicalize(&undo_root).map_err(|e| format!("撤销目录不可用：{e}"))?;
    if !path_inside(root, &undo_canon) {
        return Err("撤销目录指向工程目录之外，拒绝写入快照".into());
    }

    let target = undo_root.join(stamp).join(&relp);
    let parent = target.parent().ok_or_else(|| "快照路径没有父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("无法创建快照目录：{e}"))?;
    let parentc = fs::canonicalize(parent).map_err(|e| format!("快照目录不可用：{e}"))?;
    if !parentc.starts_with(&undo_canon) {
        return Err("快照落点不在 .zxz/undo 之下，拒绝写入".into());
    }

    let created = !target.exists();
    fs::write(&target, content.as_bytes()).map_err(|e| format!("写入快照失败（{stamp}/{rel}）：{e}"))?;
    Ok(WriteResult {
        path: target.to_string_lossy().to_string(),
        bytes: content.len(),
        created,
    })
}

/// 撤销快照读取通道（只给撤销面板用，模型侧 `read`/`list_in` 已对该区关闭）。
///
/// `stamp` 为 None 时列出撤销根下的快照目录；给出时列出该快照内 `rel` 子目录
/// （`rel` 为空表示快照根）。落点用 canonicalize 复核，必须真在 `.zxz/undo` 之下
/// ——否则 `.zxz/undo` 被换成指向别处的 junction 时，这条通道就成了新的越界读口子。
pub fn undo_list(root: &Path, stamp: Option<&str>, rel: &str) -> Result<Vec<FsEntry>, String> {
    let undo_root = root.join(".zxz").join("undo");
    if !undo_root.is_dir() {
        return Ok(Vec::new()); // 还没写过任何文件，正常情况
    }
    let undo_canon = fs::canonicalize(&undo_root).map_err(|e| format!("撤销目录不可用：{e}"))?;

    let dir = match stamp {
        None => {
            if !rel.trim().is_empty() {
                return Err("未指定快照时不能列出子目录".into());
            }
            undo_canon.clone()
        }
        Some(s) => {
            if !valid_stamp(s) {
                return Err(format!("快照标识不合法（要求形如 2026-11-01T02-49-32）：{s}"));
            }
            let base = undo_canon.join(s);
            if rel.trim().is_empty() {
                base
            } else {
                let relp = safe_rel(rel)?;
                if protected_area(&relp).is_some() {
                    return Err(format!("{rel} 落在受保护目录内：快照里不能再进快照"));
                }
                base.join(&relp)
            }
        }
    };

    let real = fs::canonicalize(&dir).map_err(|e| format!("目录不可用：{e}"))?;
    if !real.starts_with(&undo_canon) {
        return Err("目录不在撤销快照区内，拒绝访问".into());
    }
    list(real.to_string_lossy().to_string())
}

/// 读一份快照的正文。落点同样要求真在撤销区之内。
pub fn undo_read(root: &Path, stamp: &str, rel: &str) -> Result<String, String> {
    if !valid_stamp(stamp) {
        return Err(format!("快照标识不合法（要求形如 2026-11-01T02-49-32）：{stamp}"));
    }
    let relp = safe_rel(rel)?;
    if protected_area(&relp).is_some() {
        return Err(format!("{rel} 落在受保护目录内：快照里不能再进快照"));
    }
    let undo_root = root.join(".zxz").join("undo");
    let undo_canon = fs::canonicalize(&undo_root).map_err(|e| format!("撤销目录不可用：{e}"))?;
    let target = undo_canon.join(stamp).join(&relp);
    let real = fs::canonicalize(&target).map_err(|e| format!("快照不存在（{stamp}/{rel}）：{e}"))?;
    if !real.starts_with(&undo_canon) {
        return Err("快照落点不在撤销目录内，拒绝读取".into());
    }
    let md = fs::metadata(&real).map_err(|e| format!("读取失败（{stamp}/{rel}）：{e}"))?;
    if md.is_dir() {
        return Err(format!("{rel} 是目录，不是文件"));
    }
    if md.len() > MAX_READ {
        return Err(format!("{rel} 超过 4MB，拒绝读取"));
    }
    fs::read_to_string(&real).map_err(|e| format!("{rel} 不是可读的文本文件：{e}"))
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

    /// 复现：`.git` 拒绝表是基于**原始字符串**判定的，而 `safe_rel` 会把 `.` 段吃掉。
    /// 于是 `./.git/config` 的首段是 `.`、不是 `.git`，字符串判定放行，落点却是
    /// `<root>/.git/config`——上一轮那道 .git 写保护可以被一个 `.` 前缀整个绕过。
    #[test]
    fn dot_prefix_must_not_bypass_git_protection() {
        let dir = std::env::temp_dir().join(format!("zxz-fsx-dotgit-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".git")).unwrap();
        let rootc = fs::canonicalize(&dir).unwrap();
        for bad in ["./.git/config", ".git/./config", "./.git/hooks/pre-commit", ".//.git/config"] {
            assert!(write(&rootc, bad, "malicious".into()).is_err(), "应拒绝：{bad}");
        }
        assert!(!dir.join(".git/config").exists(), "被拒绝的写入不能真的落盘");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 撤销快照是「覆盖写失败时的唯一退路」，而它落在工程内的普通路径下。
    /// 修复前：模型手里的 write_file 与备份写入走的是同一条 fs_write，
    /// 于是模型可以改写自己的安全网——用户点「恢复」拿到模型准备好的内容。
    #[test]
    fn model_channel_cannot_touch_undo_snapshots() {
        let dir = std::env::temp_dir().join(format!("zxz-fsx-undo-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let rootc = fs::canonicalize(&dir).unwrap();

        // 先用专用通道放一份合法快照（证明这条通道本身可用）
        let r = undo_write(&rootc, "2026-11-01T02-49-32", "src/a.ts", "ORIGINAL".into()).unwrap();
        assert!(r.created);
        assert_eq!(fs::read_to_string(dir.join(".zxz/undo/2026-11-01T02-49-32/src/a.ts")).unwrap(), "ORIGINAL");

        // 被测：通用写通道（模型可达）必须连整个 .zxz/undo 都写不进去，
        // 大小写、分隔符、`.` 前缀三种变形一起测——判定基于规范化路径才挡得住
        for bad in [
            ".zxz/undo/2026-11-01T02-49-32/src/a.ts",
            ".ZXZ/UNDO/2026-11-01T02-49-32/src/a.ts",
            ".zxz\\undo\\2026-11-01T02-49-32\\src\\a.ts",
            "./.zxz/undo/2026-11-01T02-49-32/src/a.ts",
            ".zxz/undo/2026-11-01T02-49-32/evil.ts",
        ] {
            let e = write(&rootc, bad, "TAMPERED".into()).unwrap_err();
            assert!(e.contains(".zxz/undo"), "{bad} 应被拒绝：{e}");
        }
        // 快照内容必须一个字节都没变
        assert_eq!(
            fs::read_to_string(dir.join(".zxz/undo/2026-11-01T02-49-32/src/a.ts")).unwrap(),
            "ORIGINAL",
            "模型通道居然改掉了撤销快照"
        );

        // 对照组：.zxz/audit 是模型自己的报告产物，不该被顺手挡掉
        assert!(write(&rootc, ".zxz/audit/report.md", "ok".into()).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn undo_write_rejects_bad_stamp_and_nested_path() {
        let dir = std::env::temp_dir().join(format!("zxz-fsx-undostamp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let rootc = fs::canonicalize(&dir).unwrap();

        // stamp 是撤销通道唯一由外部给的「目录名」：放过一个分隔符就回到任意路径写入
        for bad in ["", "2026-11-01", "../..", "../../etc", "2026-11-01T02-49", "2026-11-01T02-49-32/x", "2026_11_01T02_49_32"] {
            assert!(undo_write(&rootc, bad, "a.ts", "x".into()).is_err(), "stamp 应被拒绝：{bad:?}");
        }
        // rel 不能把快照写到别处，也不能在快照里套快照
        for bad in ["../evil.ts", "/etc/passwd", ".zxz/undo/x", ".git/config", ""] {
            assert!(undo_write(&rootc, "2026-11-01T02-49-32", bad, "x".into()).is_err(), "rel 应被拒绝：{bad:?}");
        }
        // 合法落点必须在 undo/<stamp>/ 之下
        let ok = undo_write(&rootc, "2026-11-01T02-49-32", "src/lib/b.ts", "y".into()).unwrap();
        assert!(ok.path.replace('\\', "/").ends_with(".zxz/undo/2026-11-01T02-49-32/src/lib/b.ts"), "{}", ok.path);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_to_write_repo_metadata() {
        // .git 里的东西能改掉 git 的行为（fsmonitor / textconv / hooks / info/attributes），
        // 而 run_command 允许只读 git：这条口子必须封死，且大小写与分隔符都不能绕
        let dir = std::env::temp_dir().join(format!("zxz-fsx-git-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".git")).unwrap();
        let rootc = fs::canonicalize(&dir).unwrap();
        for bad in [".git/config", ".git/hooks/pre-commit", ".GIT/config", ".git\\config", ".git/info/attributes"] {
            let e = write(&rootc, bad, "malicious".into()).unwrap_err();
            assert!(e.contains(".git"), "{bad} 应被拒绝：{e}");
        }
        assert!(!dir.join(".git/config").exists(), "拒绝之后不能再落盘");
        // 名字像但不是 .git 目录的照常放行
        assert!(write(&rootc, ".gitignore", "node_modules\n".into()).is_ok());
        assert!(write(&rootc, "srcdotgit/a.txt", "ok".into()).is_ok());
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
