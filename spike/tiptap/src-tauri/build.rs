#[path = "src/google_build_config.rs"]
mod google_build_config;
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
    println!("cargo:rerun-if-changed=google-oauth.public.json");
    println!("cargo:rerun-if-env-changed=NEVIS_GOOGLE_CLIENT_ID");
    let public=google_build_config::parse(&std::fs::read_to_string("google-oauth.public.json").expect("read public Google build identity")).expect("valid public Google identity (clientId only)");
    let client=std::env::var("NEVIS_GOOGLE_CLIENT_ID").unwrap_or(public);
    google_build_config::validate(&client).expect("valid public Google Desktop client ID");
    println!("cargo:rustc-env=NEVIS_GOOGLE_CLIENT_ID={client}");
    for variable in ["NEVIS_GOOGLE_CREDENTIAL_SERVICE","NEVIS_DRIVE_SYNC_ENABLED"] {
        println!("cargo:rerun-if-env-changed={variable}");
        if let Ok(value)=std::env::var(variable){assert!(value.len()<256 && value.bytes().all(|b|b.is_ascii_alphanumeric()||b"._-".contains(&b)),"invalid public Drive build option");if variable=="NEVIS_DRIVE_SYNC_ENABLED"{assert!(value=="0" || value=="1","Drive feature option must be 0 or 1");}println!("cargo:rustc-env={variable}={value}");}
    }
    tauri_build::build()
}
