//! The one-way Markdown mirror (ADR-0009 §3, ROADMAP M12): the app writes files into a folder the person chose and NEVER reads from it.
//! A file is rewritten only when its bytes changed, atomically (a temporary name, then a rename), and only inside the chosen folder.
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Outcome { pub written: usize, pub skipped: usize, pub removed: usize }

/// `dir` + a relative path that stays inside `dir`: no absolute path, no `..`, no empty name.
pub fn inside(dir: &Path, rel: &str) -> Option<PathBuf> {
    let p = Path::new(rel);
    if rel.is_empty() || p.is_absolute() || p.components().any(|c| !matches!(c, Component::Normal(_))) { return None; }
    Some(dir.join(p))
}

pub fn sync(dir: &Path, files: &[(String, String)], remove: &[String]) -> Result<Outcome, String> {
    if !dir.is_dir() { return Err("the mirror folder does not exist".into()); }
    let mut out = Outcome::default();
    for (rel, text) in files {
        let path = inside(dir, rel).ok_or_else(|| format!("path not allowed: {rel}"))?;
        if std::fs::read(&path).map(|b| b == text.as_bytes()).unwrap_or(false) { out.skipped += 1; continue; }
        if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
        let tmp = path.with_extension("md.nevis-tmp");
        std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| { let _ = std::fs::remove_file(&tmp); e.to_string() })?;
        out.written += 1;
    }
    for rel in remove {
        let path = inside(dir, rel).ok_or_else(|| format!("path not allowed: {rel}"))?;
        if path.extension().and_then(|e| e.to_str()) == Some("md") && std::fs::remove_file(&path).is_ok() { out.removed += 1; } // only Markdown files this app made
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nevis-mirror-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn paths_never_leave_the_folder() {
        let d = tmp("paths");
        for bad in ["../x.md", "/etc/passwd", "a/../../x.md", "", "./x.md"] { assert!(inside(&d, bad).is_none(), "{bad}"); }
        assert!(inside(&d, "پوشه/صفحه--12345678.md").is_some());
    }

    #[test]
    fn only_changed_files_are_rewritten_atomically_and_removals_are_markdown_only() {
        let d = tmp("sync");
        let f = |a: &str, b: &str| vec![(a.to_string(), b.to_string())];
        assert_eq!(sync(&d, &f("a/one--1.md", "x"), &[]).unwrap(), Outcome { written: 1, skipped: 0, removed: 0 });
        assert_eq!(sync(&d, &f("a/one--1.md", "x"), &[]).unwrap(), Outcome { written: 0, skipped: 1, removed: 0 }, "unchanged: not touched");
        assert_eq!(sync(&d, &f("a/one--1.md", "y"), &[]).unwrap().written, 1);
        assert_eq!(std::fs::read_to_string(d.join("a/one--1.md")).unwrap(), "y");
        assert!(std::fs::read_dir(d.join("a")).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with("tmp")), "no temporary file is left");
        std::fs::write(d.join("keep.txt"), "mine").unwrap();
        assert_eq!(sync(&d, &[], &["a/one--1.md".into(), "keep.txt".into()]).unwrap().removed, 1);
        assert!(d.join("keep.txt").exists(), "a file that is not Markdown is never removed");
        assert!(sync(&d, &f("../escape.md", "x"), &[]).is_err());
        assert!(sync(&d.join("missing"), &[], &[]).is_err());
    }
}
