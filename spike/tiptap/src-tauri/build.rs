fn main() {
    println!("cargo:rerun-if-env-changed=NOVIQ_GITHUB_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=NOVIQ_GITHUB_APP_SLUG");
    println!("cargo:rerun-if-env-changed=NOVIQ_GITHUB_CREDENTIAL_SERVICE");
    println!("cargo:rerun-if-changed=github-app.public.json");
    // Public publisher identity only. Tokens, client secrets and private keys must never enter this file/build.
    let config: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("github-app.public.json")
            .expect("read public GitHub App configuration"),
    )
    .expect("valid public GitHub App configuration");
    let fields = config
        .as_object()
        .expect("GitHub App configuration must be an object");
    assert!(
        fields
            .keys()
            .all(|k| ["clientId", "slug"].contains(&k.as_str())),
        "Only public clientId and slug are allowed in GitHub App configuration"
    );
    for (variable, field) in [
        ("NOVIQ_GITHUB_CLIENT_ID", "clientId"),
        ("NOVIQ_GITHUB_APP_SLUG", "slug"),
    ] {
        let value = std::env::var(variable)
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| config[field].as_str().unwrap_or("").to_string());
        assert!(
            value.len() <= 128
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)),
            "Invalid public GitHub App identifier"
        );
        println!("cargo:rustc-env={variable}={value}");
    }
    tauri_build::build()
}
