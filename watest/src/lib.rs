use std::path::{Path, PathBuf};

use wasmer_api::backend::BackendClient;

pub fn api_client() -> BackendClient {
    const USERAGENT: &str = "wasmer-integration-tests-";
    let token = std::env::var("WASMER_TOKEN").expect("WASMER_TOKEN env var is not set");

    let graphql_endpoint = std::env::var("WASMER_REGISTRY")
        .expect("WASMER_REGISTRY env var is not set")
        .parse::<url::Url>()
        .expect("WASMER_REGISTRY env var is not a valid URL");
    BackendClient::new(graphql_endpoint, USERAGENT)
        .expect("Failed to create a new BackendClient")
        .with_auth_token(token)
}

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .expect("Failed to create a new reqwest::Client")
}

pub fn test_namespace() -> String {
    std::env::var("WASMER_TEST_NAMESPACE").unwrap_or_else(|_| "wasmer-tests".to_string())
}

pub fn test_app_tmp_dir() -> PathBuf {
    let p = std::env::temp_dir().join("wasmer-tests").join("apps");
    fs_err::create_dir_all(&p).expect("Failed to create test app tmp dir");
    p
}

/// Ensure a directory exists and is empty.
/// Will re-create the directory if it already exists.
pub fn ensure_clean_dir(path: &Path) -> Result<(), std::io::Error> {
    if path.exists() {
        fs_err::remove_dir_all(path)?;
    }
    fs_err::create_dir_all(path)
}
