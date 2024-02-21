use test_log;

use crate::util::{api_client, build_clean_test_app_dir, http_client, test_namespace};

/// Create a new static site app, update it and ensure the updated app is deployed.
#[test_log::test(tokio::test)]
async fn test_cli_app_create_static_site_and_update_multiple_times() {
    let name = format!(
        "test-staticsite-{}",
        uuid::Uuid::new_v4().to_string().replace("-", "")
    );
    let namespace = test_namespace();

    // Create static site app.
    let client = api_client();

    let dir = build_clean_test_app_dir(&name);

    tracing::debug!(local_path=%dir.display(), "creating app with cli");

    let status = std::process::Command::new("wasmer")
        .args(&[
            "app",
            "create",
            "-t",
            "static-website",
            "--non-interactive",
            "--owner",
            &namespace,
            "--new-package-name",
            &name,
            "--name",
            &name,
            "--path",
            dir.to_str().unwrap(),
        ])
        .spawn()
        .expect("Failed to invoke 'wasmer app create'")
        .wait()
        .expect("'wasmer app create' command failed");
    if !status.success() {
        panic!(
            "'wasmer app create' command failed with status: {:?}",
            status
        );
    }

    let html_path = dir.join("public").join("index.html");
    if !html_path.exists() {
        panic!("index.html does not exist: {}", html_path.display());
    }

    // Query the app.
    let app = wasmer_api::query::get_app(&client, namespace.clone(), name.clone())
        .await
        .expect("could not query app")
        .expect("queried app is None");
    let url = app
        .url
        .parse::<url::Url>()
        .expect("Failed to parse app URL");
    tracing::debug!(?app, "app deployed, sending request");

    // Ensure initial content is served.
    let content = fs_err::read_to_string(&html_path).expect("Failed to read index.html");
    let body = http_client()
        .get(url.clone())
        .send()
        .await
        .expect("Failed to send request")
        .error_for_status()
        .expect("Failed to get response")
        .text()
        .await
        .expect("Failed to get response body");

    assert_eq!(
        body, content,
        "initial content should match the index.html file"
    );

    // Publish the app 3 times and wait for it to update.
    for index in 1..3 {
        let start = std::time::Instant::now();
        tracing::debug!("updating app to version {}", index);
        let content = format!("v{}", index);
        std::fs::write(&html_path, &content).expect("Failed to write to index.html");

        let status = std::process::Command::new("wasmer")
            .args(&[
                "deploy",
                "--publish-package",
                "--no-persist-id",
                "--path",
                dir.to_str().unwrap(),
            ])
            .spawn()
            .expect("Failed to invoke 'wasmer deploy'")
            .wait()
            .expect("'wasmer deploy' command failed");
        if !status.success() {
            panic!("'wasmer deploy' command failed with status: {:?}", status);
        }

        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;

            let res = http_client()
                .get(url.clone())
                .send()
                .await
                .expect("Failed to send request")
                .error_for_status()
                .expect("Failed to get response");

            let body = res.text().await.expect("Failed to get response body");

            if body == *content {
                tracing::debug!(?app, "app updated to version {}", index);
                break;
            } else {
                tracing::trace!(?app, "app not updated  to version {index} yet, waiting...");
                let elaped = start.elapsed();
                let timeout = std::time::Duration::from_secs(120);
                if elaped > timeout {
                    panic!("app not updated to version {index} after {timeout:?} seconds - got '{body}' instead of '{content}'");
                }
            }
        }
    }
}

/// Create a new app, make sure it works, delete the app through the CLI and
/// ensure it stops working.
#[test_log::test(tokio::test)]
async fn test_cli_app_create_and_delete() {
    let name = format!(
        "test-app-deletion-{}",
        uuid::Uuid::new_v4().to_string().replace("-", "")
    );
    let namespace = test_namespace();

    // Create static site app.
    let client = api_client();

    let dir = build_clean_test_app_dir(&name);

    tracing::debug!(local_path=%dir.display(), "creating app with cli");

    let status = std::process::Command::new("wasmer")
        .args(&[
            "app",
            "create",
            "-t",
            "static-website",
            "--non-interactive",
            "--owner",
            &namespace,
            "--new-package-name",
            &name,
            "--name",
            &name,
            "--path",
            dir.to_str().unwrap(),
        ])
        .spawn()
        .expect("Failed to invoke 'wasmer app create'")
        .wait()
        .expect("'wasmer app create' command failed");
    if !status.success() {
        panic!(
            "'wasmer app create' command failed with status: {:?}",
            status
        );
    }

    // Query the app.

    let app = wasmer_api::query::get_app(&client, namespace.clone(), name.clone())
        .await
        .expect("could not query app")
        .expect("queried app is None");
    tracing::debug!("app deployed, sending request");

    let url = app
        .url
        .parse::<url::Url>()
        .expect("Failed to parse app URL");

    let _res = http_client()
        .get(url.clone())
        .send()
        .await
        .expect("Failed to send request")
        .error_for_status()
        .expect("Failed to get response");

    // Delete the app.
    let status = std::process::Command::new("wasmer")
        .args(&[
            "app",
            "delete",
            "--non-interactive",
            format!("{}/{}", namespace, name).as_str(),
        ])
        .spawn()
        .expect("Failed to invoke 'wasmer app delete'")
        .wait()
        .expect("'wasmer app delete' command failed");
    if !status.success() {
        panic!(
            "'wasmer app delete' command failed with status: {:?}",
            status
        );
    }

    // Wait for app to stop working.
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;

        let res = http_client()
            .get(url.clone())
            .send()
            .await
            .expect("Failed to send request");

        let status = res.status();
        let _body = res.text().await.expect("Failed to get response body");

        if !status.is_success() {
            // Should be 400
            assert_eq!(
                status,
                reqwest::StatusCode::BAD_REQUEST,
                "deleted app should return 400",
            );
            break;
        }
    }
}
