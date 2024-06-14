use std::fs::write;
use std::process::Command;
use tempfile::TempDir;
use uuid::Uuid;
use watest::deploy_dir;
use watest::deploy_hello_world_app;
use watest::mkdir;
use watest::send_get_request_to_app;
#[test_log::test(tokio::test)]

async fn test_deploy() {
    let (name, _) = deploy_hello_world_app();
    assert!(
        String::from(send_get_request_to_app(&name).await.text().await.unwrap())
            == "Hello World!\n"
    );
}

#[test_log::test(tokio::test)]
async fn test_unnamed_package() {
    let name = &Uuid::new_v4().to_string();
    let dir = TempDir::new().unwrap().into_path();

    write(
        dir.join("wasmer.toml"),
        r#"[dependencies]
"wasmer-tests/hello-world" = "*""#,
    )
    .unwrap();
    write(
        dir.join("app.yaml"),
        format!(
            r#"
kind: wasmer.io/App.v0
name: {name}
owner: wasmer-tests
package: .
"#
        ),
    )
    .unwrap();
    deploy_dir(&dir);
}

#[test_log::test(tokio::test)]
async fn test_deploy_fails_no_app_name() {
    let dir = TempDir::new().unwrap().into_path();
    write(
        dir.join("app.yaml"),
        format!(
            r#"
kind: wasmer.io/App.v0
owner: wasmer-tests
package: .
"#
        ),
    )
    .unwrap();
    assert!(!Command::new("wasmer")
        .args(["deploy", "--registry", "wasmer.wtf", "--non-interactive"])
        .current_dir(dir)
        .status()
        .unwrap()
        .success());
}

#[test_log::test(tokio::test)]
async fn test_deploy_fails_no_app_owner() {
    let name = &Uuid::new_v4().to_string();
    let dir = TempDir::new().unwrap().into_path();
    write(
        dir.join("app.yaml"),
        format!(
            r#"
kind: wasmer.io/App.v0
name: {name}
package: .
"#
        ),
    )
    .unwrap();
    assert!(!Command::new("wasmer")
        .args(["deploy", "--registry", "wasmer.wtf", "--non-interactive"])
        .current_dir(dir)
        .status()
        .unwrap()
        .success());
}

