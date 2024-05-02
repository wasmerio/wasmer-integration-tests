use crate::util::{build_clean_test_app_dir, test_namespace};
use futures::future::join_all;
use rand::seq::SliceRandom;
use std::env;
use std::path::Path;
use std::thread;
use std::time::Duration;

fn publish_package(package_path: &str) {
    tracing::debug!("publishing package at {}", package_path);
    let publish = std::process::Command::new("wasmer")
        .args(&["publish", package_path])
        .output()
        .unwrap();
    // process exits with nonzero code when package already exists.
    assert!(
        publish.status.success()
            || String::from_utf8(publish.stderr.clone())
                .unwrap()
                .contains("already exists"),
        "publising package in {} has failed. status={}, stdout={}, stderr={}",
        package_path,
        publish.status,
        String::from_utf8(publish.stdout).unwrap(),
        String::from_utf8(publish.stderr).unwrap()
    )
}

async fn create_app(name: String) {
    let namespace = test_namespace();
    let dir = build_clean_test_app_dir(&name);
    tracing::debug!("Creating app {}", name);
    let app_create_status = std::process::Command::new("wasmer")
        .args(&[
            "app",
            "create",
            "-t",
            "static-website",
            "--non-interactive",
            "--owner",
            &namespace,
            "--package",
            "cypress1/test-app",
            "--name",
            &name,
            "--no-wait",
            "--path",
            dir.to_str().unwrap(),
        ])
        .status()
        .unwrap();
    assert!(
        app_create_status.success(),
        "Creating app {} at namespace {} has failed. status={}",
        name,
        namespace,
        app_create_status
    );
    tracing::debug!("Testing if app {} is functional", name);
    let app_hostname = format!("{}-wasmer-tests.wasmer.app", name);
    let edge_url = env::var("EDGE_URL").unwrap_or("http://localhost".to_string());
    for _ in 1..100 {
        let app_response = reqwest::Client::new()
            .get(&edge_url)
            .header("Host", &app_hostname)
            .send()
            .await
            .expect(&format!(
                "Sending request to app {} to edge at {} failed. Is edge running?",
                app_hostname, edge_url
            ));
        thread::sleep(Duration::from_secs(1));
        if app_response.status().is_success() {
            return
        }
    }
    panic!("App {} is not ready", app_hostname);
}

fn load_test_apps(app_hostnames: &Vec<String>) {
    let joined_app_hostnames = app_hostnames.join(",");
    tracing::debug!("Starting load test for apps {}", joined_app_hostnames);
    let load_test_status = std::process::Command::new("k6")
        .args(&[
            "run",
            Path::new(file!())
                .parent()
                .unwrap()
                .join("loadtest.js")
                .to_str()
                .unwrap(),
        ])
        .env("TEST_APPS", &joined_app_hostnames)
        .status()
        .unwrap();
    assert!(
        load_test_status.success(),
        "Load test for apps {} has failed. status={}",
        &joined_app_hostnames,
        load_test_status
    );
}
// this should be moved to edge repo
#[test_log::test(tokio::test)]
async fn test_complex_load() {
    // Ensure packages that will be used by the apps exists in the registry
    publish_package("../packages/static-web-server");
    publish_package("../packages/test-app");

    // Create random static website apps
    let mut names = Vec::new();
    let mut apps = Vec::new();
    for i in 0..4 {
        let name = format!(
            "t-{}-{}",
            i,
            uuid::Uuid::new_v4().to_string().replace("-", "")
        );
        names.push(name.clone());
        apps.push(create_app(name));
    }
    join_all(apps).await;

    // load test the apps
    let app_hostnames = names
        .iter()
        .map(|i| format!("{}-wasmer-tests.wasmer.app", i))
        .collect::<Vec<_>>();
    load_test_apps(&app_hostnames);
    // test random apps
    load_test_apps(
        &app_hostnames
            .choose_multiple(&mut rand::thread_rng(), 5)
            .cloned()
            .collect::<Vec<_>>(),
    );
    // wait reuse_last_instance_ttl_secs and load test all apps again
    thread::sleep(Duration::from_secs(35));
    load_test_apps(&app_hostnames);
}
