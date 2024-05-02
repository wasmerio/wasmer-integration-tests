use crate::util::publish_local_package;
use std::env::temp_dir;
use std::fs::create_dir_all;
use std::fs::File;
use std::io::prelude::*;
use std::process::Command;
use uuid::Uuid;
use std::{thread, time};

#[test_log::test(tokio::test)]
async fn test_unnamed_package() {
    let app_name = &Uuid::new_v4().to_string();
    let app_dir = &temp_dir().join(app_name);
    create_dir_all(app_dir).unwrap();

    publish_local_package("../packages/static-web-server");
    publish_local_package("../packages/test-app");

    let mut package_file = File::create(app_dir.join("wasmer.toml")).unwrap();
    package_file
        .write_all(
br#"[dependencies]
"cypress1/test-app" = "*""#,
        )
        .unwrap();

    let mut app_file = File::create(app_dir.join("app.yaml")).unwrap();
    app_file
        .write_all(
            format!(
                r#"
kind: wasmer.io/App.v0
name: {}
package: .
"#,
                app_name
            )
            .as_bytes(),
        )
        .unwrap();

    assert!(Command::new("wasmer")
        .args(["deploy", "--no-wait", "--owner", "wasmer-tests"])
        .current_dir(app_dir)
        .status()
        .unwrap()
        .success());
    let mut app_healthy = false;
    let app_url = format!("{}-wasmer-tests.wasmer.app", app_name);
    for _ in 1..32 {
        let response_code = reqwest::Client::new()
        .get("http://localhost")
        .header("Host", &app_url)
        .send()
        .await
        .unwrap()
        .status();
        if response_code.is_success() {
            app_healthy = true;
            break;
        }
        thread::sleep(time::Duration::from_secs(1));
    }
    assert!(app_healthy, "App {app_name} is not healthy. URL={}", app_url)
}
