use reqwest::Response;
use std::fs::write;
use std::path::PathBuf;
use tempfile::TempDir;
use uuid::Uuid;

pub const REGISTRY_PROD: &str = "https://registry.wasmer.io/graphql";

pub fn manifest_dir() -> PathBuf {
    std::env::var("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .expect("CARGO_MANIFEST_DIR env var not set")
}

pub fn wasmopticon_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("WASMOPTICON_DIR") {
        let path = PathBuf::from(dir);
        if !path.exists() {
            panic!(
                "WASMOPTICON_DIR env var set, but directory does not exist: '{}'",
                path.display()
            );
        }
        path
    } else {
        manifest_dir().join("wasmopticon")
    }
}

pub struct TestEnv {
    pub registry: url::Url,
    pub namespace: String,
    pub app_domain: String,
}

impl TestEnv {
    pub fn load() -> Self {
        env()
    }
}

pub fn env() -> TestEnv {
    const DEFAULT_REGISTRY: &str = "https://registry.wasmer.wtf/graphql";
    const DEFAULT_NAMESPACE: &str = "wasmer-integration-tests";
    const DEFAULT_APP_DOMAIN: &str = "wasmer.dev";

    let registry = std::env::var("WASMER_REGISTRY")
        .unwrap_or_else(|_| DEFAULT_REGISTRY.to_string())
        .parse()
        .expect("Invalid registry URL");
    let namespace =
        std::env::var("WASMER_NAMESPACE").unwrap_or_else(|_| DEFAULT_NAMESPACE.to_string());
    let app_domain =
        std::env::var("WASMER_APP_DOMAIN").unwrap_or_else(|_| DEFAULT_APP_DOMAIN.to_string());

    TestEnv {
        registry,
        namespace,
        app_domain,
    }
}

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("wasmer-integration-tests")
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap()
}

pub fn get_random_app_name() -> String {
    let uuid = Uuid::new_v4().to_string();
    String::from(&uuid[1..25])
}

pub fn deploy_hello_world_app() -> (String, PathBuf) {
    let dir = TempDir::new().unwrap().into_path();
    let name = get_random_app_name();
    write(
        dir.join("app.yaml"),
        format!(
            r#"
kind: wasmer.io/App.v0
name: {name}
owner: wasmer-integration-tests
package: wasmer-integration-tests/hello-world
    "#
        ),
    )
    .unwrap();
    deploy_dir(&dir);
    (name, dir)
}

pub async fn send_get_request_to_app(name: &String) -> Response {
    let app_domain = env().app_domain;
    reqwest::Client::new()
        .get(format!(
            "https://{name}-wasmer-integration-tests.{app_domain}"
        ))
        .send()
        .await
        .unwrap()
}

pub async fn send_get_request_to_url(url: &str) -> Response {
    reqwest::Client::new().get(url).send().await.unwrap()
}

#[derive(Debug)]
pub struct DeployedAppInfo {
    pub version_id: String,
    pub url: url::Url,
    pub app_id: String,
}

pub fn deploy_dir_with_args<I, S>(dir: &PathBuf, extra_args: I) -> DeployedAppInfo
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let result = assert_cmd::Command::new("wasmer")
        .args(&["deploy", "--non-interactive", "--format=json"])
        .arg("--registry")
        .arg(env().registry.as_str())
        .args(extra_args)
        .current_dir(dir)
        .assert()
        .success();

    let output = result.get_output();

    let status = match serde_json::from_slice::<serde_json::Value>(&output.stdout) {
        Ok(v) => v,
        Err(err) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);

            panic!(
                "Could not parse  output of 'wasmer deploy' as json: {err}:\n=====\n{}\n=====\n{}\n=====",
                stdout, stderr
            );
        }
    };

    DeployedAppInfo {
        version_id: status["id"].as_str().unwrap().to_string(),
        url: status["url"]
            .as_str()
            .unwrap()
            .parse()
            .expect("invalid URL"),
        app_id: status["app"]["id"].as_str().unwrap().to_string(),
    }
}

pub fn deploy_dir(dir: &PathBuf) -> DeployedAppInfo {
    deploy_dir_with_args(dir, Vec::<String>::new())
}

/// Macro that creates a directory structure with file contents.
///
/// # Example
///
/// ```rust
/// use watest::mkdir;
/// use tempfile::TempDir;
/// let dir = TempDir::new().unwrap().into_path();
///
/// mkdir!(dir; {
///   "a.txt" => "a",
///   "b" => {
///     "b1.txt" => "b1",
///     "c" => {
///       "c1.txt" => "c1",
///     },
///   },
/// });
/// ````
#[macro_export]
macro_rules! mkdir {
    (__block $root:expr ; ) => {};

    (__block $root:expr ; { $($rest:tt)* } ) => {
        mkdir!( __block $root ; $($rest)* );
    };

    (__block $root:expr ; $sub:literal => { $($rest:tt)* } $($extra:tt)* ) => {
        mkdir!(__block $root.join($sub); $( $rest )* );
        mkdir!(__block $root; $($extra)* );
    };

    (__block $root:expr ; $sub:literal => $content:expr , $($rest:tt)* ) => {
        {
            {
                let full = $root.join($sub);
                if let Some(parent) = full.parent() {
                    std::fs::create_dir_all(parent).unwrap();
                }
                std::fs::write(&full, $content).unwrap();
            }

            mkdir!(__block $root ; $($rest)* );
        }
    };

    (__block $root:expr ; $(,)* ) => {};

    // Nested directories
    ($root:expr ; { $($rest:tt)* } ) => {
        mkdir!( __block $root ; $($rest)* );
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mkdir() {
        let dir = TempDir::new().unwrap().into_path();
        mkdir!(dir; {
            "a.txt" => "a",
            "b" => {
                "b1.txt" => "b1",
                "c" => {
                    "c1.txt" => "c1",
                },
            }
        });

        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "a");
        assert_eq!(std::fs::read_to_string(dir.join("b/b1.txt")).unwrap(), "b1");
        assert_eq!(
            std::fs::read_to_string(dir.join("b/c/c1.txt")).unwrap(),
            "c1"
        );
    }
}
