use std::{
    fs::{create_dir, write},
    process::Command,
    time::Duration,
};
use tempfile::TempDir;
use test_log;
use tokio::time::sleep;
use watest::{deploy_dir, deploy_hello_world_app, env, get_random_app_name, send_get_request_to_app};
use yaml_rust::YamlLoader;
#[test_log::test(tokio::test)]
#[ignore = "there is too many apps for the integration test user, new apps wont get listed due to page limits"]
async fn test_app_listing() {
    let mut names = vec![];
    for _ in 1..2 {
        let (name, _) = deploy_hello_world_app();
        names.push(name.clone());
    }
    let listed_apps = &YamlLoader::load_from_str(
        &String::from_utf8(
            Command::new("wasmer")
                .args(["app", "list", "--all", "-f", "yaml"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap(),
    )
    .unwrap()[0];
    for name in &names {
        assert!(listed_apps
            .as_vec()
            .unwrap()
            .iter()
            .any(|e| e["name"].as_str().unwrap() == name));
    }
}

#[test_log::test(tokio::test)]
#[ignore = "app deletion is problematic to test due to weird behaviour, test manually"]
async fn test_app_delete() {
    let (name, dir) = deploy_hello_world_app();
    assert!(Command::new("wasmer")
        .args(["app", "delete", "--non-interactive"])
        .current_dir(dir)
        .status()
        .unwrap()
        .success());
    sleep(Duration::from_secs(180)).await;
    assert!(!send_get_request_to_app(&name).await.status().is_success())
}

#[test_log::test(tokio::test)]
async fn test_app_info_get() {
    let (name, dir) = deploy_hello_world_app();
    let info_output = String::from_utf8(
        Command::new("wasmer")
            .args(["app", "info"])
            .current_dir(&dir)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    let app_domain = env().app_domain;
    let expected_url = format!("https://{name}-wasmer-integration-tests.{app_domain}");
    assert!(info_output.contains(&format!("Name: {name}")));
    assert!(info_output.contains(&format!("URL: {expected_url}")));

    let get_output = YamlLoader::load_from_str(
        &String::from_utf8(
            Command::new("wasmer")
                .args(["app", "get"])
                .current_dir(dir)
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap(),
    )
    .unwrap()[0]
        .clone();
    assert!(get_output["name"].as_str().unwrap() == name);
    assert!(get_output["url"].as_str().unwrap() == expected_url);
}

#[test_log::test(tokio::test)]
async fn test_logs() {
    let name = get_random_app_name();
    let dir = TempDir::new().unwrap().into_path();
    write(
        dir.join("wasmer.toml"),
        r#"
[dependencies]
"wasmer/python" = "*"
"#,
    )
    .unwrap();

    write(
        dir.join("app.yaml"),
        format!(
            r#"
kind: wasmer.io/App.v0
name: {name}
owner: wasmer-integration-tests
package: .
cli_args:
- -c 
- print("Hello World!")
"#
        ),
    )
    .unwrap();
    // --no-wait because app doesnt have an http server, so healthcheck from cli will fail
    assert!(Command::new("wasmer")
        .args(["deploy", "--no-wait"])
        .current_dir(&dir)
        .status()
        .unwrap()
        .success());
    // because of --no-wait, the app didnt received any http request, thus not spawned
    // so send a sample request to spawn it
    send_get_request_to_app(&name).await;
    sleep(Duration::from_secs(10)).await;
    let logs = String::from_utf8(
        Command::new("wasmer")
            .args(["app", "logs"])
            .current_dir(dir)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    assert!(logs.contains("Hello World!"), "{logs}");
}

#[test_log::test(tokio::test)]
async fn test_update_multiple_times() {
    let name = get_random_app_name();
    let dir = TempDir::new().unwrap().into_path();
    create_dir(dir.join("public")).unwrap();
    write(
        dir.join("wasmer.toml"),
        r#"
[dependencies]
"wasmer/static-web-server" = "*"

[fs]
"/public" = "public"

[[command]]
name = "script"
module = "wasmer/static-web-server:webserver"
runner = "https://webc.org/runner/wasi"    
"#,
    )
    .unwrap();
    write(
        dir.join("app.yaml"),
        format!(
            r#"
kind: wasmer.io/App.v0
name: {name}
owner: wasmer-integration-tests
package: .
    "#
        ),
    )
    .unwrap();

    for i in 0..3 {
        let content = format!("hello-{i}");
        write(dir.join("public/index.html"), &content).unwrap();
        deploy_dir(&dir);
        assert!(send_get_request_to_app(&name).await.text().await.unwrap() == content);
    }
}

#[test_log::test(tokio::test)]
async fn test_cli_app_create_from_package() {
    let name = get_random_app_name();
    let dir = TempDir::new().unwrap().into_path();

    assert!(Command::new("wasmer")
        .args([
            "app",
            "create",
            "--name",
            &name,
            "--owner",
            "wasmer-integration-tests",
            "--package",
            "wasmer-integration-tests/hello-world",
            "--deploy"
        ])
        .current_dir(dir)
        .status()
        .unwrap()
        .success());
    assert!(send_get_request_to_app(&name).await.status().is_success());
}
