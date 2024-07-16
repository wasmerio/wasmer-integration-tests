use std::time::Duration;

use tempfile::TempDir;
use uuid::Uuid;
use watest::{http_client, mkdir};

/// Instaboot cache purge test.
///
/// Uses a PHP app that creates a timestamp file during instaboot, and
/// then returns that timestamp value in responses.
///
/// PHP app running the local php-instaboot-timestamp package.
#[test_log::test(tokio::test)]
async fn test_app_cache_purge_instaboot_php() {
    let dir = TempDir::new().unwrap();
    let path = dir.path();
    let watest::TestEnv {
        namespace,
        app_domain,
        ..
    } = watest::env();

    let name = format!("test-{}", Uuid::new_v4());
    let domain = format!("{name}.{app_domain}");

    let pkg_dir = watest::manifest_dir()
        .join("fixtures")
        .join("php-instaboot-timestamp")
        .to_str()
        .unwrap()
        .to_string();

    mkdir!(path; {
        "app.yaml" => format!(r#"
kind: wasmer.io/App.v0
name: {name}
owner: {namespace}
package: {pkg_dir}
debug: true
domains:
  - {domain}
capabilities:
  instaboot:
    requests:
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

    eprintln!("fetching url: {url}");
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
        "bootsrap=journal+memory",
    );

    let body = res.text().await.unwrap();
    eprintln!("body: '{body}'");

    let timestamp1 = body
        .trim()
        .parse::<u64>()
        .expect("could not parse timestamp in body: not a number");

    tokio::time::sleep(Duration::from_secs(1)).await;

    // now purge the cache.
    eprintln!("purging the cache...");
    assert_cmd::Command::new("wasmer")
        .args(&["app", "purge-cache"])
        .current_dir(&path)
        .assert()
        .success();

    // Wait a bit to make sure the cache purge was propagated.
    eprintln!("waiting for cache purge propagation...");
    tokio::time::sleep(std::time::Duration::from_secs(10)).await;

    let _res = client
        .get(&url)
        .header("x-edge-purge-instances", "1")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();

    let body2 = client
        .get(&url)
        .header("x-edge-purge-instances", "1")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .text()
        .await
        .unwrap();

    let timestamp2 = body2
        .trim()
        .parse::<u64>()
        .expect("could not parse timestamp in body: not a number");

    eprintln!("timestamp1: {timestamp1}, timestamp2: {timestamp2}");
    assert!(
        timestamp2 > timestamp1,
        "expected timestamp to be greater (meaning the journal was purged)"
    );
}
