//! Per-account daily raw HTTP counters. These are observations, not Google's quota units or bills.
use super::{core::bytes, snapshot, transport::Meter};
use crate::vault::{err, write_atomic, Res};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::Path};
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Usage {
    schema_version: u32,
    days: BTreeMap<i64, Meter>,
}
fn merge(a: &mut Meter, b: &Meter) {
    a.requests = a.requests.saturating_add(b.requests);
    a.uploaded_bytes = a.uploaded_bytes.saturating_add(b.uploaded_bytes);
    a.downloaded_bytes = a.downloaded_bytes.saturating_add(b.downloaded_bytes);
    a.rate_limits = a.rate_limits.saturating_add(b.rate_limits);
    a.elapsed_ms = a.elapsed_ms.saturating_add(b.elapsed_ms);
    for (k, v) in &b.operations {
        let old = a.operations.entry(k.clone()).or_default();
        *old = old.saturating_add(*v);
    }
    a.header_latency_ms
        .extend(b.header_latency_ms.iter().copied());
    if a.header_latency_ms.len() > 512 {
        a.header_latency_ms.drain(..a.header_latency_ms.len() - 512);
    }
}
pub fn record(data: &Path, subject: &str, now: i64, meter: &Meter) -> Res<Value> {
    let folder = data.join("drive");
    fs::create_dir_all(&folder).map_err(err)?;
    let key = snapshot::hash(subject.as_bytes());
    let path = folder.join(format!("usage-{key}.json"));
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(folder.join("usage.lock"))
        .map_err(err)?;
    lock.try_lock().map_err(|_| "DRIVE:metrics_busy")?;
    let mut usage: Usage = match fs::read(&path) {
        Ok(b) => serde_json::from_slice(&b).map_err(|_| "DRIVE:metrics_corrupt")?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Usage {
            schema_version: 1,
            ..Default::default()
        },
        Err(e) => return Err(err(e)),
    };
    if usage.schema_version != 1 {
        return Err("DRIVE:metrics_schema".into());
    }
    let day = now.div_euclid(86_400_000);
    merge(usage.days.entry(day).or_default(), meter);
    usage.days.retain(|d, _| *d >= day - 30);
    write_atomic(&path, &bytes(&usage)?)?;
    let today = &usage.days[&day];
    let mut samples = today.header_latency_ms.clone();
    samples.sort_unstable();
    let percentile = |p: usize| {
        samples
            .get(samples.len().saturating_sub(1) * p / 100)
            .copied()
    };
    Ok(
        json!({"dayUtc":day,"today":today,"headerLatencyP50Ms":percentile(50),"headerLatencyP95Ms":percentile(95),"sampleWindow":512,"softDailyRequestBudget":100_000,"nearSoftBudget":today.requests>=80_000,"billingEstimate":null,"quotaUnits":null,"note":"Raw HTTP requests across this account on this installation; excludes OAuth and requests by other clients. Check Google Console for quota units and billing."}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn daily_counters_accumulate_and_rotate_with_bounded_latency_samples() {
        let root = std::env::temp_dir().join(format!("nevis-metrics-{}", uuid::Uuid::new_v4()));
        let m = Meter {
            requests: 3,
            header_latency_ms: vec![10, 20, 100],
            ..Default::default()
        };
        record(&root, "private-subject", 0, &m).unwrap();
        let day = record(&root, "private-subject", 0, &m).unwrap();
        assert_eq!(day["today"]["requests"], 6);
        assert_eq!(day["headerLatencyP50Ms"], 20);
        let next = record(&root, "private-subject", 86_400_000, &m).unwrap();
        assert_eq!(next["today"]["requests"], 3);
        assert!(next["billingEstimate"].is_null());
        fs::remove_dir_all(root).unwrap();
    }
}
