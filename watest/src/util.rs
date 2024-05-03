use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context};
use tracing::info;
use url::Url;
use wasmer_api::WasmerClient;

pub fn registry_endpoint() -> url::Url {
    std::env::var("WASMER_REGISTRY")
        .expect("WASMER_REGISTRY env var is not set")
        .parse::<url::Url>()
        .expect("WASMER_REGISTRY env var is not a valid URL")
}

pub fn api_client() -> WasmerClient {
    const USERAGENT: &str = "wasmer-integration-tests-";
    let token = std::env::var("WASMER_TOKEN").expect("WASMER_TOKEN env var is not set");

    let graphql_endpoint = registry_endpoint();
    WasmerClient::new(graphql_endpoint, USERAGENT)
        .expect("Failed to create a new WasmerClient")
        .with_auth_token(token)
}

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .pool_max_idle_per_host(0)
        .build()
        .expect("Failed to create a new reqwest::Client")
}

pub fn test_namespace() -> String {
    std::env::var("WASMER_TEST_NAMESPACE").unwrap_or_else(|_| "wasmer-tests".to_string())
}

pub fn edge_server_url() -> Url {
    let raw =
        std::env::var("WASMER_EDGE_SERVER_URL").expect("WASMER_EDGE_SERVER_URL env var is not set");
    let full = if !raw.starts_with("http") {
        format!("http://{}", raw)
    } else {
        raw
    };
    full.parse()
        .expect("WASMER_EDGE_SERVER_URL env var is not a valid URL")
}

pub fn build_app_request(
    client: &reqwest::Client,
    app: &wasmer_api::types::DeployApp,
    url: Url,
    method: reqwest::Method,
) -> reqwest::RequestBuilder {
    let app_host = app
        .url
        .parse::<Url>()
        .unwrap()
        .host()
        .expect("app url has no host")
        .to_string();
    tracing::info!(app_host);
    let mut target_url = edge_server_url();
    target_url.set_path(url.path());
    target_url.set_query(url.query());

    client
        .request(method, target_url)
        .header(reqwest::header::HOST, app_host)
}

pub fn build_app_request_get(
    client: &reqwest::Client,
    app: &wasmer_api::types::DeployApp,
    url: Url,
) -> reqwest::RequestBuilder {
    build_app_request(client, app, url, reqwest::Method::GET)
}

/// Wait for an app to be at the latest version.
pub async fn wait_app_latest_version(
    client: &reqwest::Client,
    app: &wasmer_api::types::DeployApp,
) -> Result<reqwest::Response, anyhow::Error> {
    let latest_version = app.active_version.id.inner();
    info!("waiting for app to be at version {}", latest_version);
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;

    let start = std::time::Instant::now();
    loop {
        if start.elapsed() > std::time::Duration::from_secs(240) {
            bail!("Timed out waiting for app to be available");
        }

        let url = format!("http://{}-wasmer-tests.wasmer.app", app.name)
            .parse()
            .unwrap();
        tracing::info!(app.name);
        let req = build_app_request_get(client, app, url);
        tracing::debug!(?req, "Sending request to app to check version");

        let res = req.send().await.context("Failed to send request to app")?;

        if res.status().is_success() {
            let version = res
                .headers()
                .get("X-Edge-App-Version-Id")
                .and_then(|v| v.to_str().ok());
            if version == Some(latest_version) {
                break Ok(res);
            }
        } else {
            tracing::debug!(
                status = res.status().as_u16(),
                "request to app failed with non-success status"
            );
        }

        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
}

// Create a clean directory for a test app.
// Will purge the directory if it already exists.
//
// NOTE: not using tempfile::tempdir to make it easier to inspect the directory
// if tests fail.
pub fn build_clean_test_app_dir(test_name: &str) -> PathBuf {
    if test_name.len() > 50 {
        panic!(
            "name '{test_name}' too long - the backend limits package/app names to length of 50"
        );
    }
    let dir = test_app_tmp_dir().join(test_name);
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

pub async fn mirror_package_prod_to_local(
    namespace: impl Into<String>,
    name: impl Into<String>,
) -> Result<wasmer_api::types::PackageVersionWithPackage, anyhow::Error> {
    let namespace = namespace.into();
    let name = name.into();

    let source_backend = "https://registry.wasmer.io/graphql".parse().unwrap();
    let target_backend = registry_endpoint();
    let target_token = std::env::var("WASMER_TOKEN").expect("WASMER_TOKEN env var is not set");
    mirror_package(
        namespace,
        name,
        source_backend,
        target_backend,
        target_token,
    )
    .await
}

pub async fn mirror_package(
    namespace: String,
    name: String,
    source_backend: Url,
    target_backend: Url,
    target_token: String,
) -> Result<wasmer_api::types::PackageVersionWithPackage, anyhow::Error> {
    info!(
        "Mirroring package {}/{} from {} to {}",
        namespace, name, source_backend, target_backend
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
    std::process::Command::new("tar")
        .args(&["-xzf", archive_path.to_str().unwrap()])
        .current_dir(&tmp_dir)
        .status_success()
        .unwrap();

    let wapm_path = tmp_dir.join("wapm.toml");
    if wapm_path.exists() {
        fs_err::rename(wapm_path, tmp_dir.join("wasmer.toml"))?;
    }

    tracing::debug!("Publishing package to target registry");
    let status = std::process::Command::new("wasmer")
        .args(&[
            "publish",
            "--registry",
            target_backend.as_str(),
            "--no-validate",
            "--timeout",
            "600sec",
        ])
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
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    // Wait for webc availability
    let start = std::time::Instant::now();
    loop {
        if start.elapsed() > std::time::Duration::from_secs(600) {
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

pub trait CommandExt {
    /// Run the command and return an error if the result status is not 0.
    fn status_success(&mut self) -> Result<(), std::io::Error>;

    fn output_success(&mut self) -> Result<CommandOutput, std::io::Error>;
}

#[derive(PartialEq, Eq, Debug)]
pub struct CommandOutput {
    pub status: std::process::ExitStatus,
    pub stdout: String,
    pub stderr: String,
}

impl CommandExt for std::process::Command {
    fn status_success(&mut self) -> Result<(), std::io::Error> {
        let status = self.status()?;
        if !status.success() {
            let cmd = self.get_program().to_string_lossy();
            let args = self
                .get_args()
                .map(|a| a.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ");

            Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Command '{cmd} {args}' failed with status: {:?}", status),
            ))
        } else {
            Ok(())
        }
    }

    fn output_success(&mut self) -> Result<CommandOutput, std::io::Error> {
        let output = self.output()?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        if !output.status.success() {
            let cmd = self.get_program().to_string_lossy();
            let args = self
                .get_args()
                .map(|a| a.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ");

            Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!(
                    "Command '{cmd} {args}' failed with status: {:?}\nSTDOUT: {}\n\nSTDERR: {}",
                    output.status, stdout, stderr,
                ),
            ))
        } else {
            Ok(CommandOutput {
                status: output.status,
                stdout,
                stderr,
            })
        }
    }
}

pub fn publish_local_package(package_path: &str) {
    let result = Command::new("wasmer")
        .arg("publish")
        .current_dir(package_path)
        .output()
        .unwrap();
    assert!(
        result.status.success()
            || String::from_utf8(result.stderr.clone())
                .unwrap()
                .contains("already exists")
            || String::from_utf8(result.stderr.clone())
                .unwrap()
                .contains("Could not create package"),
        "Publishing local package at {} failed. status={}, stdout={}, stderr={}",
        package_path,
        result.status.code().unwrap(),
        String::from_utf8(result.stdout).unwrap(),
        String::from_utf8(result.stderr).unwrap()
    );
}
