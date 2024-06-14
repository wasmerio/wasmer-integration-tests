use reqwest::Response;
use std::fs::write;
use std::path::PathBuf;
use std::process::Command;
use tempfile::TempDir;
use uuid::Uuid;

pub const REGISTRY_PROD: &str = "https://registry.wasmer.io/graphql";

pub struct TestEnv {
    pub registry: url::Url,
    pub namespace: String,
    pub app_domain: String,
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

pub fn deploy_hello_world_app() -> (String, PathBuf) {
    let dir = TempDir::new().unwrap().into_path();
    let name = Uuid::new_v4().to_string();
    write(
        dir.join("app.yaml"),
        format!(
            r#"
kind: wasmer.io/App.v0
name: {name}
owner: wasmer-tests
package: wasmer-tests/hello-world
    "#
        ),
    )
    .unwrap();
    deploy_dir(&dir);
    (name, dir)
}

pub async fn send_get_request_to_app(name: &String) -> Response {
    reqwest::Client::new()
        .get(format!("https://{name}-wasmer-tests.wasmer.dev"))
        .send()
        .await
        .unwrap()
}

pub fn deploy_dir(dir: &PathBuf) {
    assert!(Command::new("wasmer")
        .args(["deploy", "--non-interactive", "--registry", "wasmer.wtf"])
        .current_dir(dir)
        .status()
        .unwrap()
        .success());
}

/// Macro that creates a directory structure with file contents.
///
/// # Example
///
/// ```rust
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
