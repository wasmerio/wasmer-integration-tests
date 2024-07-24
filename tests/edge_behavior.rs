use std::{fs::write, process::Command, thread::sleep, time::Duration};

use tempfile::TempDir;
use watest::{
    deploy_dir, deploy_hello_world_app, env, get_random_app_name, http_client, mkdir,
    send_get_request_to_app, send_get_request_to_url, TestEnv,
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
    let app_domain = env().app_domain;
    let resp = reqwest::Client::new()
        .get(format!(
            "https://echo-server-wasmer-integration-tests.{app_domain}/hello?format=json"
        ))
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
        format!("echo-server-wasmer-integration-tests.{app_domain}")
    );
}

#[test_log::test(tokio::test)]
async fn test_gateway_head() {
    let app_domain = env().app_domain;
    let resp = reqwest::Client::new()
        .head(format!(
            "https://echo-server-wasmer-integration-tests.{app_domain}/hello?format=json"
        ))
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success());
    assert_eq!(resp.text().await.unwrap(), "");
}

#[test_log::test(tokio::test)]
async fn test_gateway_post() {
    let app_domain = env().app_domain;
    let resp = reqwest::Client::new()
        .post(format!(
            "https://echo-server-wasmer-integration-tests.{app_domain}/hello?format=json"
        ))
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
        format!("echo-server-wasmer-integration-tests.{app_domain}")
    );
}

#[test_log::test(tokio::test)]
async fn app_redeployed_quickly() {
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
    let yaml = YamlLoader::load_from_str(
        &String::from_utf8(
            Command::new("wasmer")
                .args(["app", "get", &format!("wasmer-integration-tests/{name}")])
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
owner: wasmer-integration-tests
package: wasmer-integration-tests/hello-world
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
