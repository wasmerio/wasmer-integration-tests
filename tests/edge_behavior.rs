use std::{fs::write, process::Command, thread::sleep, time::Duration};

use tempfile::TempDir;
use uuid::Uuid;
use watest::{
    deploy_dir, deploy_hello_world_app, send_get_request_to_app, send_get_request_to_url,
};
use yaml_rust::YamlLoader;

#[test_log::test(tokio::test)]
async fn test_instance_respawn() {
    let (name, _) = deploy_hello_world_app();
    assert!(send_get_request_to_app(&name).await.status().is_success());
    sleep(Duration::from_secs(65));
    assert!(send_get_request_to_app(&name).await.status().is_success());
}

#[test_log::test(tokio::test)]
async fn test_gateway_get() {
    let resp = reqwest::Client::new()
        .get("https://echo-server-wasmer-tests.wasmer.dev/hello?format=json")
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success());
    let data = json::parse(&resp.text().await.unwrap()).unwrap();
    assert_eq!(data["method"], "GET");
    assert_eq!(data["body"], "");
    assert_eq!(data["headers"]["accept"], "*/*");
    // ??
    // assert_eq!(data["headers"]["accept-encoding"], "gzip, deflate");
    // assert_eq!(data["headers"]["connection"], "keep-alive");
    assert_eq!(
        data["headers"]["host"],
        "echo-server-wasmer-tests.wasmer.dev"
    );
}

#[test_log::test(tokio::test)]
async fn test_gateway_head() {
    let resp = reqwest::Client::new()
        .head("https://echo-server-wasmer-tests.wasmer.dev/hello?format=json")
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success());
    assert_eq!(resp.text().await.unwrap(), "");
}

#[test_log::test(tokio::test)]
async fn test_gateway_post() {
    let resp = reqwest::Client::new()
        .post("https://echo-server-wasmer-tests.wasmer.dev/hello?format=json")
        .body("body")
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success());
    let data = json::parse(&resp.text().await.unwrap()).unwrap();
    assert_eq!(data["method"], "POST");
    assert_eq!(data["body"], "body");
    assert_eq!(data["headers"]["accept"], "*/*");
    assert_eq!(data["headers"]["content-length"], "4");
    // assert_eq!(data["headers"]["accept-encoding"], "gzip, deflate");
    // assert_eq!(data["headers"]["connection"], "keep-alive");
    assert_eq!(
        data["headers"]["host"],
        "echo-server-wasmer-tests.wasmer.dev"
    );
}

#[test_log::test(tokio::test)]
async fn app_redeployed_quickly() {
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
    let yaml = YamlLoader::load_from_str(
        &String::from_utf8(
            Command::new("wasmer")
                .args(["app", "get", &format!("wasmer-tests/{name}")])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap(),
    )
    .unwrap()[0]
        .clone();
    let url = yaml["url"].as_str().unwrap();
    assert!(Command::new("wasmer")
        .args(["app", "delete", "--non-interactive"])
        .current_dir(&dir)
        .status()
        .unwrap()
        .success());
    while send_get_request_to_url(url).await.status().is_success() {}
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
    assert!(Command::new("wasmer")
        .args(["deploy", "--non-interactive", "--no-wait"])
        .current_dir(dir)
        .status()
        .unwrap()
        .success());
    sleep(Duration::from_secs(10));
    assert!(send_get_request_to_url(url).await.status().is_success());
}
