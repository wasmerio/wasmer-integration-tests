use std::{thread::sleep, time::Duration};

use watest::{deploy_hello_world_app, send_get_request_to_app};

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
    assert_eq!(data["headers"]["host"], "echo-server-wasmer-tests.wasmer.dev");
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
    assert_eq!(data["headers"]["host"], "echo-server-wasmer-tests.wasmer.dev");
}