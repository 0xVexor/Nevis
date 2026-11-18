fn flag(name: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(include_str!("../../release-features.json"))
        .ok().and_then(|flags| flags.get(name).and_then(|value| value.as_bool())).unwrap_or(false)
}
pub fn slides_enabled() -> bool { flag("slides") }
/// Pages migrate to Yjs states (`pages-state/`) only when this is on and the server says it can store them.
pub fn page_state_enabled() -> bool { flag("pageState") }
#[cfg(test)]
mod tests {
    #[test]
    fn stable_release_disables_slides() { assert!(!super::slides_enabled()); }
    #[test]
    fn page_state_is_off_by_default() { assert!(!super::page_state_enabled()); }
}
