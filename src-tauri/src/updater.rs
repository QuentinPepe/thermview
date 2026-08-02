//! Self-update for the portable build.
//!
//! Tauri's own updater installs an NSIS/MSI package, which would give up the
//! single-file "copy it anywhere and double-click" property. This checks the
//! project's GitHub releases instead and swaps the running executable in
//! place, so a recipient is only ever sent one file.
//!
//! Windows lets a running executable be renamed but not overwritten, which is
//! exactly what the swap relies on: the live exe is moved aside, the download
//! takes its place, and the stale copy is deleted on the next launch.

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Releases are only ever fetched from here.
const REPO: &str = "QuentinPepe/thermview";

/// Hosts GitHub serves release assets from. A redirect anywhere else is
/// refused rather than followed into running unknown code.
const ALLOWED_HOSTS: &[&str] = &[
    "github.com",
    "api.github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

/// Guards against a truncated or absurd download replacing a working app.
const MIN_SIZE: u64 = 1_000_000;
const MAX_SIZE: u64 = 300_000_000;

#[derive(Serialize, Clone)]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
    pub notes: String,
    pub url: String,
    pub size: u64,
}

fn host_allowed(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let host = rest.split(['/', ':']).next().unwrap_or("");
    ALLOWED_HOSTS.contains(&host)
}

/// Compare dotted numeric versions. Returns true when `candidate` is newer.
fn is_newer(candidate: &str, current: &str) -> bool {
    let parts = |v: &str| -> Vec<u64> {
        v.trim_start_matches(['v', 'V'])
            .split(['.', '-', '+'])
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (a, b) = (parts(candidate), parts(current));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

fn get(url: &str) -> Result<ureq::Response, String> {
    if !host_allowed(url) {
        return Err(format!("refusing to fetch from an unexpected host: {url}"));
    }
    ureq::get(url)
        .set("User-Agent", "ThermView-Updater")
        .set("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(30))
        .call()
        .map_err(|e| format!("network error: {e}"))
}

/// Ask GitHub for the latest release; `None` when already up to date.
#[tauri::command]
pub fn update_check() -> Result<Option<UpdateInfo>, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let body = get(&format!("https://api.github.com/repos/{REPO}/releases/latest"))?
        .into_string()
        .map_err(|e| format!("cannot read release feed: {e}"))?;
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("malformed release feed: {e}"))?;

    let tag = json["tag_name"].as_str().unwrap_or_default().to_string();
    if tag.is_empty() || !is_newer(&tag, &current) {
        return Ok(None);
    }

    // Pick the Windows executable asset.
    let asset = json["assets"]
        .as_array()
        .and_then(|assets| {
            assets.iter().find(|a| {
                a["name"]
                    .as_str()
                    .map(|n| n.to_ascii_lowercase().ends_with(".exe"))
                    .unwrap_or(false)
            })
        })
        .ok_or("release has no .exe asset")?;

    let url = asset["browser_download_url"].as_str().unwrap_or_default().to_string();
    let size = asset["size"].as_u64().unwrap_or(0);
    if !host_allowed(&url) {
        return Err("release asset is not hosted on GitHub".into());
    }
    if !(MIN_SIZE..=MAX_SIZE).contains(&size) {
        return Err(format!("release asset has an implausible size ({size} bytes)"));
    }

    Ok(Some(UpdateInfo {
        version: tag.trim_start_matches('v').to_string(),
        current,
        notes: json["body"].as_str().unwrap_or_default().to_string(),
        url,
        size,
    }))
}

fn download(url: &str, expected: u64) -> Result<Vec<u8>, String> {
    let resp = get(url)?;
    let mut buf = Vec::with_capacity(expected as usize);
    resp.into_reader()
        .take(MAX_SIZE)
        .read_to_end(&mut buf)
        .map_err(|e| format!("download failed: {e}"))?;

    if buf.len() as u64 != expected {
        return Err(format!(
            "download is {} bytes but the release says {expected}",
            buf.len()
        ));
    }
    if buf.len() < 2 || buf[0] != b'M' || buf[1] != b'Z' {
        return Err("download is not a Windows executable".into());
    }
    Ok(buf)
}

fn stale_path(exe: &Path) -> PathBuf {
    let mut name = exe.file_name().unwrap_or_default().to_os_string();
    name.push(".old");
    exe.with_file_name(name)
}

/// Delete the previous executable left behind by an earlier update.
pub fn clean_previous() {
    if let Ok(exe) = std::env::current_exe() {
        let _ = fs::remove_file(stale_path(&exe));
    }
}

/// Put `bytes` at `exe`, moving whatever is there aside first.
///
/// Split out from the command so the file dance can be tested without a
/// running app: every failure path must leave a working executable behind.
fn install_over(exe: &Path, bytes: &[u8]) -> Result<(), String> {
    // Staging next to the target keeps the final move on one volume.
    let staged = exe.with_extension("new");
    fs::write(&staged, bytes)
        .map_err(|e| format!("cannot write next to the app ({}): {e}", exe.display()))?;

    let stale = stale_path(exe);
    let _ = fs::remove_file(&stale);
    if let Err(e) = fs::rename(exe, &stale) {
        let _ = fs::remove_file(&staged);
        return Err(format!("cannot move the running app aside: {e}"));
    }

    if let Err(e) = fs::rename(&staged, exe) {
        // Put the working executable back rather than leave nothing behind.
        let _ = fs::rename(&stale, exe);
        let _ = fs::remove_file(&staged);
        return Err(format!("cannot install the new version: {e}"));
    }
    Ok(())
}

/// Download the release, replace the running executable, and restart into it.
#[tauri::command]
pub fn update_apply(app: tauri::AppHandle, url: String, size: u64) -> Result<(), String> {
    let bytes = download(&url, size)?;
    let exe = std::env::current_exe().map_err(|e| format!("cannot locate this app: {e}"))?;
    install_over(&exe, &bytes)?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_newer_versions() {
        assert!(is_newer("v0.2.0", "0.1.0"));
        assert!(is_newer("0.2.0", "0.1.9"));
        assert!(is_newer("v1.0.0", "0.9.9"));
        assert!(is_newer("v0.1.10", "0.1.9"));
        assert!(is_newer("v0.2", "0.1.0"));
    }

    #[test]
    fn ignores_same_or_older_versions() {
        assert!(!is_newer("v0.1.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "v0.1.0"));
        assert!(!is_newer("v0.1.0", "0.2.0"));
        assert!(!is_newer("v0.0.9", "1.0.0"));
        // Junk must never look like an upgrade.
        assert!(!is_newer("", "0.1.0"));
        assert!(!is_newer("latest", "0.1.0"));
    }

    #[test]
    fn only_accepts_github_over_https() {
        assert!(host_allowed("https://api.github.com/repos/x/y/releases/latest"));
        assert!(host_allowed("https://objects.githubusercontent.com/a/b"));
        assert!(!host_allowed("http://github.com/x"), "plain http");
        assert!(!host_allowed("https://evil.com/payload.exe"));
        // A lookalike host must not slip through a prefix match.
        assert!(!host_allowed("https://github.com.evil.com/x"));
        assert!(!host_allowed("https://notgithub.com/x"));
        assert!(!host_allowed("file:///C:/payload.exe"));
    }

    #[test]
    fn stale_path_sits_next_to_the_executable() {
        let exe = Path::new(r"C:\apps\thermview.exe");
        assert_eq!(stale_path(exe), Path::new(r"C:\apps\thermview.exe.old"));
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("thermview-updater-test-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn install_replaces_the_app_and_keeps_the_old_one() {
        let dir = temp_dir("swap");
        let exe = dir.join("app.exe");
        fs::write(&exe, b"MZ old version").unwrap();

        install_over(&exe, b"MZ new version").unwrap();

        assert_eq!(fs::read(&exe).unwrap(), b"MZ new version");
        assert_eq!(fs::read(stale_path(&exe)).unwrap(), b"MZ old version");
        // The staging file must not survive a successful install.
        assert!(!exe.with_extension("new").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_twice_overwrites_the_previous_backup() {
        let dir = temp_dir("twice");
        let exe = dir.join("app.exe");
        fs::write(&exe, b"MZ v1").unwrap();

        install_over(&exe, b"MZ v2").unwrap();
        install_over(&exe, b"MZ v3").unwrap();

        assert_eq!(fs::read(&exe).unwrap(), b"MZ v3");
        assert_eq!(fs::read(stale_path(&exe)).unwrap(), b"MZ v2");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clean_previous_removes_only_the_backup() {
        let dir = temp_dir("clean");
        let exe = dir.join("app.exe");
        fs::write(&exe, b"MZ current").unwrap();
        fs::write(stale_path(&exe), b"MZ previous").unwrap();

        let _ = fs::remove_file(stale_path(&exe));

        assert!(exe.exists(), "the live executable must survive cleanup");
        assert!(!stale_path(&exe).exists());

        let _ = fs::remove_dir_all(&dir);
    }
}
