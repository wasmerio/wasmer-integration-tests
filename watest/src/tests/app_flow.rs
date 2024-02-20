use test_log;

use crate::util::{api_client, build_clean_test_app_dir, http_client, test_namespace};

/// Create a new app, make sure it works, delete the app through the CLI and
/// ensure it stops working.
#[test_log::test(tokio::test)]
async fn test_app_creation_and_deletion_through_cli() {
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

    let app = wasmer_api::backend::get_app(&client, namespace.clone(), name.clone())
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

