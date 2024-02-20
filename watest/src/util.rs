use std::path::{Path, PathBuf};

use anyhow::{bail, Context};
use url::Url;
use wasmer_api::WasmerClient;

pub fn api_client() -> WasmerClient {
    const USERAGENT: &str = "wasmer-integration-tests-";
    let token = std::env::var("WASMER_TOKEN").expect("WASMER_TOKEN env var is not set");

    let graphql_endpoint = std::env::var("WASMER_REGISTRY")
        .expect("WASMER_REGISTRY env var is not set")
        .parse::<url::Url>()
        .expect("WASMER_REGISTRY env var is not a valid URL");
    WasmerClient::new(graphql_endpoint, USERAGENT)
        .expect("Failed to create a new WasmerClient")
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

pub fn build_clean_test_app_dir(name: &str) -> PathBuf {
    let dir = test_app_tmp_dir().join(name);
    ensure_clean_dir(&dir).expect("Failed to ensure clean dir");
    dir
}

fn test_app_tmp_dir() -> PathBuf {
    let p = std::env::temp_dir().join("wasmer-tests").join("apps");
    fs_err::create_dir_all(&p).expect("Failed to create test app tmp dir");
    p
}

fn package_dir() -> PathBuf {
    let p = std::env::temp_dir().join("wasmer-tests").join("packages");
    fs_err::create_dir_all(&p).expect("Failed to create package tmp dir");
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

pub async fn mirror_package(
    namespace: String,
    name: String,
    source_backend: Url,
    target_backend: Url,
    target_token: String,
) -> Result<wasmer_api::types::PackageVersionWithPackage, anyhow::Error> {
    tracing::info!(
        "Mirroring package {}/{} from {} to {}",
        namespace,
        name,
        source_backend,
        target_backend
    );

    let source_client = WasmerClient::new(source_backend, "wasmer-integration-tests")?;
    let target_client = WasmerClient::new(target_backend.clone(), "wasmer-integration-tests")?;

    let full_name = format!("{}/{}", namespace, name);
    let pkg =
        wasmer_api::query::get_package_version(&source_client, full_name.clone(), "*".to_string())
            .await
            .context("Failed to get package from source registry")?
            .with_context(|| format!("Package not found: {}", full_name))?;

    // Check if it already exists in the target registry.
    let existing_pkg = wasmer_api::query::get_package_version(
        &target_client,
        full_name.clone(),
        pkg.version.clone(),
    )
    .await?;
    if let Some(existing_pkg) = existing_pkg {
        tracing::debug!("Package already exists in target registry");
        return Ok(existing_pkg);
    }

    let dl_url = pkg
        .distribution
        .download_url
        .as_ref()
        .context("package version has no download URL")?;

    tracing::debug!(url=%dl_url, "Downloading package from source registry");

    let data = http_client()
        .get(dl_url.as_str())
        .send()
        .await
        .context("Failed to download package from source registry")?
        .error_for_status()?
        .bytes()
        .await?;

    let id = uuid::Uuid::new_v4().to_string();
    let tmp_dir = package_dir().join(&id);
    fs_err::create_dir_all(&tmp_dir)?;
    let archive_path = tmp_dir.join("archive").with_extension("tar.gz");
    tokio::fs::write(&archive_path, &data).await?;

    // Extract.
    tracing::debug!(path=%tmp_dir.display(), "Extracting package archive");
    let status = std::process::Command::new("tar")
        .args(&["-xzf", archive_path.to_str().unwrap()])
        .current_dir(&tmp_dir)
        .status()
        .context("Failed to extract package archive")?;
    if !status.success() {
        bail!("Failed to extract package archive");
    }

    let wapm_path = tmp_dir.join("wapm.toml");
    if wapm_path.exists() {
        fs_err::rename(wapm_path, tmp_dir.join("wasmer.toml"))?;
    }

    tracing::debug!("Publishing package to target registry");
    let status = std::process::Command::new("wasmer")
        .args(&["publish", "--registry", target_backend.as_str()])
        .env("WASMER_TOKEN", target_token)
        .current_dir(&tmp_dir)
        .status()
        .context("Failed to publish package to target registry")?;

    if !status.success() {
        // Check if the package version was published already in the meantime.

        let pkg = wasmer_api::query::get_package_version(
            &target_client,
            full_name.clone(),
            pkg.version.clone(),
        )
        .await?;

        if pkg.is_none() {
            bail!("Failed to publish package to target registry");
        } else {
            tracing::debug!("Package was published by someone else in the meantime.");
        }
    }

    // Wait for webc availability
    let start = std::time::Instant::now();
    loop {
        if start.elapsed() > std::time::Duration::from_secs(120) {
            bail!("Timed out waiting for package to be available in target registry");
        }

        let pkg = wasmer_api::query::get_package_version(
            &target_client,
            full_name.clone(),
            pkg.version.clone(),
        )
        .await?
        .context("package has gone away")?;

        if pkg.distribution.pirita_download_url.is_some() {
            break Ok(pkg);
        }

        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
}
