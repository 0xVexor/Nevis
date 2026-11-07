pub fn slides_enabled() -> bool {
    serde_json::from_str::<serde_json::Value>(include_str!("../../release-features.json"))
        .ok().and_then(|flags| flags.get("slides").and_then(|value| value.as_bool())).unwrap_or(false)
}
#[cfg(test)]
mod tests {
    #[test]
    fn stable_release_disables_slides() { assert!(!super::slides_enabled()); }
}
