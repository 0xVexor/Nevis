//! Shared validation for public build identity; confidential OAuth JSON is rejected, never printed.
pub fn parse(raw: &str) -> Result<String, &'static str> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| "Invalid public Google configuration")?;
    let object = value
        .as_object()
        .ok_or("Public Google configuration must be an object")?;
    if object.keys().any(|k| k != "clientId") {
        return Err(
            "Only public clientId is allowed; do not store credential JSON or secrets here",
        );
    }
    let id = object
        .get("clientId")
        .and_then(serde_json::Value::as_str)
        .ok_or("Public Google clientId must be a string")?;
    validate(id)?;
    Ok(id.into())
}
pub fn validate(id: &str) -> Result<(), &'static str> {
    if id.is_empty() {
        return Ok(());
    }
    if id.len() > 255
        || !id.ends_with(".apps.googleusercontent.com")
        || id.len() <= 26
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err("Invalid public Google Desktop client ID");
    }
    Ok(())
}
// Desktop clients are public clients: this publisher parameter is distributed in
// the binary. It is never an account token or proof that the app is confidential.
pub fn publisher_parameter(value: &str) -> Result<&str, &'static str> {
    if value.len() > 1024
        || (!value.is_empty()
            && (!value.bytes().all(|b| b.is_ascii_graphic())
                || value.ends_with(".apps.googleusercontent.com")))
    {
        return Err("Invalid Desktop publisher parameter; value omitted");
    }
    Ok(value)
}
pub fn require_publisher(
    enabled: bool,
    developer_setup: bool,
    client: &str,
    parameter: &str,
) -> Result<(), &'static str> {
    validate(client)?;
    publisher_parameter(parameter)?;
    if !parameter.is_empty() && client.is_empty() {
        return Err("Desktop publisher parameter requires a client ID");
    }
    if enabled && !developer_setup && (client.is_empty() || parameter.is_empty()) {
        return Err("Drive builds require publisher OAuth configuration; supply NEVIS_GOOGLE_DESKTOP_CLIENT_SECRET through the build environment");
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn customer_build_requires_publisher_configuration_without_echoing_it() {
        let id = "123456-example.apps.googleusercontent.com";
        assert!(require_publisher(true, false, id, "dummy-desktop-value").is_ok());
        assert!(require_publisher(true, false, id, "").is_err());
        assert!(require_publisher(true, true, id, "").is_ok());
        assert!(require_publisher(false, false, id, "").is_ok());
        for bad in [
            "contains secret whitespace".to_string(),
            "x".repeat(1025),
            id.into(),
        ] {
            assert_eq!(
                publisher_parameter(&bad).unwrap_err(),
                "Invalid Desktop publisher parameter; value omitted"
            );
        }
    }
    #[test]
    fn only_public_client_identity_is_accepted() {
        let id = "123456-example.apps.googleusercontent.com";
        assert_eq!(parse(&format!(r#"{{"clientId":"{id}"}}"#)).unwrap(), id);
        assert_eq!(parse(r#"{"clientId":""}"#).unwrap(), "");
        for raw in [
            r#"{"clientId":"","clientSecret":"do-not-log"}"#,
            r#"{"installed":{"client_secret":"do-not-log"}}"#,
            r#"{"clientId":"https://not-a-client"}"#,
        ] {
            let error = parse(raw).unwrap_err();
            assert!(!error.contains("do-not-log"));
        }
        assert!(validate("not-a-client").is_err());
    }
}
