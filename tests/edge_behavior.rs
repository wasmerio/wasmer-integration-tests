use std::{fs::write, process::Command, time::Duration};

use tempfile::TempDir;
use tokio::time::sleep;
use watest::{
    deploy_dir, deploy_dir_with_args, deploy_hello_world_app, env, get_random_app_name,
    http_client, send_get_request_to_app, wasmopticon_dir,
};

#[test_log::test(tokio::test)]
async fn test_instance_respawn() {
    let (name, _) = deploy_hello_world_app();
    assert!(send_get_request_to_app(&name).await.status().is_success());
    sleep(Duration::from_secs(310)).await;
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
#[ignore = "app deletion is problematic to test due to weird behaviour, test manually"]
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
    assert!(Command::new("wasmer")
        .args(["app", "delete", "--non-interactive"])
        .current_dir(&dir)
        .status()
        .unwrap()
        .success());
    sleep(Duration::from_secs(65)).await;
    assert!(!send_get_request_to_app(&name).await.status().is_success());
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
    sleep(Duration::from_secs(65)).await;
    assert!(send_get_request_to_app(&name).await.status().is_success());
}

#[test_log::test(tokio::test)]
async fn app_volumes() {
    let dir = TempDir::new().unwrap().into_path();
    let name = get_random_app_name();
    let pkg_dir = wasmopticon_dir()
        .join("php/php-testserver")
        .to_str()
        .unwrap()
        .to_string();

    write(
        dir.join("app.yaml"),
        format!(
            r#"
kind: wasmer.io/App.v0
name: {name}
owner: wasmer-integration-tests
package: {pkg_dir}
debug: true
volumes:
- name: data
  mounts:
  - mount_path: /data1
    "#
        ),
    )
    .unwrap();
    let meta = deploy_dir_with_args(&dir, ["--bump"]);
    let client = http_client();

    // Write a file to the volume.
    {
        let mut url = meta.url.clone();
        url.set_path("/fs/write/data1/file1");
        client.post(url).body("value1").send().await.unwrap();
    }

    // Read the data
    {
        let mut url = meta.url.clone();
        url.set_path("/fs/read/data1/file1");
        let resp = client.get(url).send().await.unwrap();
        assert_eq!(resp.text().await.unwrap(), "value1");
    }

    // Now read again, but force a fresh instance to make sure it wasn't just stored in memory.
    {
        let mut url = meta.url.clone();
        url.set_path("/fs/read/data1/file1");
        let resp = client
            .get(url)
            .header("x-edge-purge-instances", "1")
            .send()
            .await
            .unwrap();
        assert_eq!(resp.text().await.unwrap(), "value1");
    }
}
