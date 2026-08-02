//! Hits the real GitHub releases feed. Opt-in so offline builds and CI stay
//! deterministic: set THERMVIEW_LIVE_UPDATE_TEST=1 to run it.

#[test]
fn queries_the_real_release_feed() {
    if std::env::var("THERMVIEW_LIVE_UPDATE_TEST").is_err() {
        eprintln!("skipped: set THERMVIEW_LIVE_UPDATE_TEST=1 to run");
        return;
    }

    match thermview_lib::updater::update_check() {
        Ok(Some(u)) => {
            println!(
                "update offered: {} -> {} | {:.2} MB | {}",
                u.current,
                u.version,
                u.size as f64 / 1e6,
                u.url
            );
            assert!(u.url.starts_with("https://"), "asset must be served over https");
            assert!(u.url.to_ascii_lowercase().ends_with(".exe"));
            assert!(u.size > 1_000_000);
            assert_ne!(u.version, u.current);
        }
        Ok(None) => println!("no update: already on the latest release"),
        Err(e) => panic!("update check failed: {e}"),
    }
}
