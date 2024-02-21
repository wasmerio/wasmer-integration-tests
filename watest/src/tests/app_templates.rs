use test_log;

use crate::util::{api_client, build_clean_test_app_dir, http_client, test_namespace};

/// Create a new static site app, update it and ensure the updated app is deployed.
#[test_log::test(tokio::test)]
async fn test_cli_app_create_winterjs() {
    let client = api_client();

    // Make sure the WinterJS package is on the registry.

    crate::util::mirror_package(
        "wasmer".to_string(),
        "winterjs".to_string(),
        wasmer_api::ENDPOINT_PROD.parse().unwrap(),
        client.graphql_endpoint().clone(),
        client.auth_token().expect("no auth token set").to_owned(),
    )
    .await
    .unwrap();

    let name = format!(
        "test-winterjs-{}",
        uuid::Uuid::new_v4().to_string().replace("-", "")
    );
    let namespace = test_namespace();

    // Create static site app.

    let dir = build_clean_test_app_dir(&name);

    tracing::debug!(local_path=%dir.display(), "creating app with cli");

    let status = std::process::Command::new("wasmer")
        .args(&[
            "app",
            "create",
            "-t",
            "js-worker",
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
    let url = app
        .url
        .parse::<url::Url>()
        .expect("Failed to parse app URL");
    tracing::debug!(?app, "app deployed, sending request");

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

    let json: serde_json::Value =
        serde_json::from_str(&body).expect("Failed to parse response body");
    let success = json
        .get("success")
        .expect("Response body has no 'success' field")
        .as_bool()
        .expect("Response body 'success' field is not a boolean");
    assert_eq!(success, true);
}
