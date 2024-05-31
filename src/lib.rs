use reqwest::Response;
use std::fs::write;
use std::path::PathBuf;
use std::process::Command;
use tempfile::TempDir;
use uuid::Uuid;

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