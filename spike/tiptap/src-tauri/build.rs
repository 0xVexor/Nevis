fn main() {
    println!("cargo:rerun-if-env-changed=NOVIQ_GITHUB_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=NOVIQ_GITHUB_APP_SLUG");
    println!("cargo:rerun-if-env-changed=NOVIQ_GITHUB_CREDENTIAL_SERVICE");
    tauri_build::build()
}
