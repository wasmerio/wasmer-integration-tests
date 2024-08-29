use std::{fs::write, process::Command, time::Duration};

use tempfile::TempDir;
use tokio::time::sleep;
use watest::{
    deploy_dir, deploy_dir_with_args, deploy_hello_world_app, env, get_random_app_name,
    http_client, mkdir, send_get_request_to_app, wasmopticon_dir, TestEnv,
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

#[test_log::test(tokio::test)]
async fn app_https_redirect() {
    let dir = TempDir::new().unwrap().into_path();
    let path = dir.to_path_buf();
    let name = get_random_app_name();

    let TestEnv { namespace, .. } = TestEnv::load();

    // First create app without https redirect, and make sure no redirect happens.

    mkdir!(&path; {
        "wasmer.toml" => format!(r#"
            [dependencies]
            "wasmer/static-web-server" = "*"

            [fs]
            public = "public"
        "#),

        "public/index.html" => "index",
        "public/sub.html" => "sub",

        "app.yaml" => format!(r#"
kind: wasmer.io/App.v0
name: {name}
owner: {namespace}
package: .
redirect:
  force_https: false
"#),
    });

    let info = deploy_dir(&dir);

    // Want a client with no redirects.
    let client = reqwest::Client::builder()
        .user_agent("wasmer-integration-tests")
        .connect_timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();

    assert_eq!(info.url.scheme(), "https");

    let mut url_http = info.url.clone();
    url_http.set_scheme("http").unwrap();

    // Should not redirect.
    let resp = client
        .get(url_http.clone())
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(resp.status(), 200);

    // https should work.
    let resp = client
        .get(info.url.clone())
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(resp.status(), 200);

    // Now re-deploy the app with https redirect enabled.
    write(
        dir.join("app.yaml"),
        format!(
            r#"
kind: wasmer.io/App.v0
name: {name}
owner: wasmer-integration-tests
package: wasmer-integration-tests/hello-world
redirect:
  force_https: true
    "#
        ),
    )
    .unwrap();
    let info = deploy_dir(&dir);

    let mut url_http = info.url.clone();
    url_http.set_scheme("http").unwrap();

    // Should redirect.
    let resp = client
        .get(url_http.clone())
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(resp.status(), 308);

    let location = resp
        .headers()
        .get("location")
        .unwrap()
        .to_str()
        .unwrap()
        .trim_end_matches('/');
    assert_eq!(location, info.url.as_str().trim_end_matches('/'));

    // redirect should work with path.
    let mut url_path = url_http.clone();
    url_path.set_path("/sub");

    let resp = client
        .get(url_path)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(resp.status(), 308);
    let location = resp
        .headers()
        .get("location")
        .unwrap()
        .to_str()
        .unwrap()
        .trim_end_matches('/');
    assert_eq!(
        location,
        info.url.join("sub").unwrap().as_str().trim_end_matches('/')
    );
}
