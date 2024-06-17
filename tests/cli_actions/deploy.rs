use std::fs::write;
use std::process::Command;
use tempfile::TempDir;
use uuid::Uuid;
use watest::deploy_dir;
use watest::deploy_hello_world_app;
use watest::http_client;
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

/// Deploy a PHP app with instaboot, and make sure a journal-restored instance
/// has PHP files cached in the opcache.
#[test_log::test(tokio::test)]
async fn test_app_instaboot_php_opcache() {
    let dir = TempDir::new().unwrap();
    let path = dir.path();
    let watest::TestEnv {
        namespace,
        app_domain,
        ..
    } = watest::env();

    let name = format!("test-{}", Uuid::new_v4());

    let domain = format!("{name}.{app_domain}");

    mkdir!(path; {
        "wasmer.toml" => format!(r#"
            [dependencies]
            "php/php" = "8.3.4"

            [fs]
            "app" = "./app"
            "config" = "./config"

            [[command]]
            name = "run"
            module = "php/php:php"
            runner = "wasi"

            [command.annotations.wasi]
            main-args = ["-t", "/app", "-S", "0.0.0.0:8080"]
            env = ["PHPRC=/config/php.ini"]

        "#),

        "config/php.ini" => r#"
opcache.validate_timestamps = 0
opcache.file_update_protection = 0
opcache.max_file_size = 0
"#,
        "app/index.php" => r#"
        <?php

        print(json_encode(opcache_get_status(), JSON_PRETTY_PRINT));
        "#,

        "app.yaml" => format!(r#"
kind: wasmer.io/App.v0
name: {name}
owner: {namespace}
package: .
debug: true
domains:
  - {domain}
capabilities:
  instaboot:
    requests:
      - path: /
      - path: /
      - path: /
"#),
    });

    assert_cmd::Command::new("wasmer")
        .args(&["deploy", "--non-interactive", "--no-wait"])
        .current_dir(&dir)
        .assert()
        .success();

    let url = format!("https://{domain}/");

    eprintln!("fetching url {url}");

    {
        let res = reqwest::Client::new()
            .get(&url)
            .header("x-edge-purge-instances", "1")
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();

        assert_eq!(
            res.headers()
                .get("x-edge-instance-journal-status")
                .expect("missing required header")
                .to_str()
                .unwrap(),
            "none",
        );

        let data = res.json::<serde_json::Value>().await.unwrap();
        let cache_hits = data["opcache_statistics"]["hits"].as_u64().unwrap();
        assert_eq!(cache_hits, 0);
    }

    let res = reqwest::Client::new()
        .get(&url)
        .header("x-edge-purge-instances", "1")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();

    assert_eq!(
        res.headers()
            .get("x-edge-instance-journal-status")
            .expect("missing required header")
            .to_str()
            .unwrap(),
        "bootsrap=journal+memory",
    );

    let data = res.json::<serde_json::Value>().await.unwrap();
    let cache_hits = data["opcache_statistics"]["hits"].as_u64().unwrap();
    assert!(cache_hits > 0);
}

/// Instaboot file system test.
///
/// Populates the file system with a file during the bootstrap phase, and
/// then makes sure the file is still present in instabooted instances.
///
/// PHP app running the php-testserver package, which provides URIs for accessing
/// the file system.
#[test_log::test(tokio::test)]
async fn test_app_instaboot_php_fs() {
    // Ensure submodules are cloned, because the php-testserver package from
    // the wasmopticon submodule is needed.
    watest::ensure_submodules();

    let dir = TempDir::new().unwrap();
    let path = dir.path();
    let watest::TestEnv {
        namespace,
        app_domain,
        ..
    } = watest::env();

    let name = format!("test-{}", Uuid::new_v4());
    let domain = format!("{name}.{app_domain}");

    let testerver_pkg_dir = watest::wasmopticon_dir()
        .join("pkg")
        .join("php-testserver")
        .to_str()
        .unwrap()
        .to_string();

    mkdir!(path; {
        "app.yaml" => format!(r#"
kind: wasmer.io/App.v0
name: {name}
owner: {namespace}
package: {testerver_pkg_dir}
debug: true
domains:
  - {domain}
capabilities:
  instaboot:
    requests:
      - path: /fs/write/tmp/hello.txt
        body: hello
"#),
    });

    assert_cmd::Command::new("wasmer")
        .args(&["deploy", "--non-interactive", "--no-wait"])
        .current_dir(&dir)
        .assert()
        .success();

    let url = format!("https://{domain}/");

    eprintln!("fetching url {url}");

    let client = http_client();

    {
        let res = client
            .get(&url)
            .header("x-edge-purge-instances", "1")
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();

        assert_eq!(
            res.headers()
                .get("x-edge-instance-journal-status")
                .expect("missing required header")
                .to_str()
                .unwrap(),
            "none",
        );
    }

    let mut fs_url = url.clone();
    fs_url.push_str("fs/read/tmp/hello.txt");

    eprintln!("fetching url: {fs_url}");
    let res = client
        .get(&fs_url)
        .header("x-edge-purge-instances", "1")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();

    assert_eq!(
        res.headers()
            .get("x-edge-instance-journal-status")
            .expect("missing required header")
            .to_str()
            .unwrap(),
        "bootsrap=journal+memory",
    );

    let body = res.text().await.unwrap();
    eprintln!("body: '{body}'");
    assert_eq!(body, "hello", "unexpected file body");
}
