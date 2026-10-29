//! Durable mandatory quota deadlines. Publication pacing never bypasses this gate.
use super::core::bytes;
use crate::vault::{write_atomic, Res};
use std::{
    fs,
    path::Path,
    time::{Duration, SystemTime},
};
pub fn retry_seconds(header: Option<&str>, now: SystemTime) -> u64 {
    let Some(value) = header else {
        return 60;
    };
    if let Ok(seconds) = value.trim().parse::<u64>() {
        return seconds.max(60);
    }
    httpdate::parse_http_date(value)
        .ok()
        .and_then(|at| at.duration_since(now).ok())
        .map(|duration| {
            duration
                .as_secs()
                .saturating_add(u64::from(duration.subsec_nanos() > 0))
                .max(60)
        })
        .unwrap_or(60)
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RetryState {
    deadline: i64,
    failures: u32,
}
fn saved(path: &Path) -> Res<Option<RetryState>> {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("DRIVE:retry_state_unreadable".into()),
    };
    let state = if let Ok(deadline) = serde_json::from_slice::<i64>(&raw) {
        RetryState {
            deadline,
            failures: 0,
        }
    } else {
        serde_json::from_slice::<RetryState>(&raw).map_err(|_| "DRIVE:retry_state_corrupt")?
    };
    if state.deadline < 0 || state.failures > 16 {
        return Err("DRIVE:retry_state_corrupt".into());
    }
    Ok(Some(state))
}
pub fn enforce(path: &Path, now: i64) -> Res<()> {
    if let Some(state) = saved(path)? {
        if state.deadline > now {
            return Err(format!(
                "DRIVE:rate_limited:{}",
                state.deadline.saturating_sub(now).saturating_add(999) / 1000
            ));
        }
    }
    Ok(())
}
pub fn record(path: &Path, message: &str, now: i64) -> Res<()> {
    if let Some(seconds) = message
        .strip_prefix("DRIVE:rate_limited:")
        .and_then(|s| s.parse::<u64>().ok())
    {
        let old = saved(path)?;
        let failures = old
            .as_ref()
            .map_or(0, |s| s.failures)
            .saturating_add(1)
            .min(16);
        let exponential = (60u64 << failures.saturating_sub(1).min(6)).min(3600);
        let delta = seconds.max(exponential).min(i64::MAX as u64) as i64;
        let deadline = now
            .saturating_add(delta.saturating_mul(1000))
            .max(old.map_or(0, |s| s.deadline));
        write_atomic(path, &bytes(&RetryState { deadline, failures })?)?;
    }
    Ok(())
}
pub fn success(path: &Path) -> Res<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("DRIVE:retry_state_unreadable".into()),
    }
}
/// Interactive edits settle quickly; sustained typing still publishes bounded batches.
pub const EDIT_QUIET: Duration = Duration::from_secs(1);
pub const EDIT_MAX_WAIT: Duration = Duration::from_secs(10);
pub fn edit_wait(quiet_elapsed: Duration, total_elapsed: Duration) -> Duration {
    EDIT_QUIET
        .saturating_sub(quiet_elapsed)
        .min(EDIT_MAX_WAIT.saturating_sub(total_elapsed))
}
pub fn publication_allowed(last: Option<i64>, now: i64, automatic: bool) -> bool {
    !automatic || last.is_none_or(|at| now.saturating_sub(at) >= 1_000)
}
pub fn wake_delay(delay: Duration) -> Duration {
    delay.min(Duration::from_secs(24 * 3600))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_quota_errors_back_off_across_restarts_and_reset_after_success() {
        let root =
            std::env::temp_dir().join(format!("nevis-rate-repeated-{}", uuid::Uuid::new_v4()));
        let path = root.join("deadline");
        let mut now = 1000;
        for delay in [60, 120, 240, 480, 960, 1920, 3600, 3600] {
            record(&path, "DRIVE:rate_limited:1", now).unwrap();
            assert_eq!(
                enforce(&path, now).unwrap_err(),
                format!("DRIVE:rate_limited:{delay}")
            );
            now += delay * 1000;
            enforce(&path, now).unwrap();
        }
        success(&path).unwrap();
        record(&path, "DRIVE:rate_limited:1", now).unwrap();
        assert_eq!(enforce(&path, now).unwrap_err(), "DRIVE:rate_limited:60");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn retry_deadline_survives_restart_and_manual_publication_does_not_bypass() {
        let root = std::env::temp_dir().join(format!("nevis-rate-{}", uuid::Uuid::new_v4()));
        let path = root.join("deadline");
        record(&path, "DRIVE:rate_limited:120", 1000).unwrap();
        assert!(publication_allowed(Some(1000), 1100, false));
        assert_eq!(enforce(&path, 1100).unwrap_err(), "DRIVE:rate_limited:120");
        assert!(enforce(&path, 121000).is_ok());
        write_atomic(&path, b"broken").unwrap();
        assert_eq!(
            enforce(&path, 500000).unwrap_err(),
            "DRIVE:retry_state_corrupt"
        );
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert_eq!(
            enforce(&path, 500000).unwrap_err(),
            "DRIVE:retry_state_unreadable"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn extreme_quota_headers_neither_overflow_nor_kill_the_worker() {
        let root = std::env::temp_dir().join(format!("nevis-rate-max-{}", uuid::Uuid::new_v4()));
        let path = root.join("deadline");
        record(&path, &format!("DRIVE:rate_limited:{}", u64::MAX), 1000).unwrap();
        assert!(enforce(&path, 2000)
            .unwrap_err()
            .starts_with("DRIVE:rate_limited:"));
        let delay = wake_delay(Duration::from_secs(u64::MAX));
        assert!(std::time::Instant::now().checked_add(delay).is_some());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn http_date_and_delta_retry_headers_respect_server_time() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let future = httpdate::fmt_http_date(now + Duration::from_secs(3600));
        assert_eq!(retry_seconds(Some(&future), now), 3600);
        assert_eq!(retry_seconds(Some("120"), now), 120);
        assert_eq!(retry_seconds(Some("malformed"), now), 60);
        assert_eq!(retry_seconds(Some(&u64::MAX.to_string()), now), u64::MAX);
    }
    #[test]
    fn edits_settle_in_one_second_and_continuous_typing_cannot_starve_publication() {
        assert_eq!(
            edit_wait(Duration::ZERO, Duration::ZERO),
            Duration::from_secs(1)
        );
        assert_eq!(
            edit_wait(Duration::from_millis(400), Duration::from_secs(9)),
            Duration::from_millis(600)
        );
        assert_eq!(
            edit_wait(Duration::ZERO, Duration::from_secs(10)),
            Duration::ZERO
        );
        assert_eq!(
            edit_wait(Duration::from_secs(2), Duration::from_secs(2)),
            Duration::ZERO
        );
    }
    #[test]
    fn automatic_spacing_is_one_second_and_clock_rollback_is_conservative() {
        assert!(!publication_allowed(Some(1000), 1_999, true));
        assert!(publication_allowed(Some(1000), 2_000, true));
        assert!(publication_allowed(Some(1000), 1100, false));
        assert!(!publication_allowed(Some(10_000), 1, true));
    }
}
