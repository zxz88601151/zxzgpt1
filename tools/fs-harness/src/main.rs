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
