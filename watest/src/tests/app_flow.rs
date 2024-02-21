use test_log;

use crate::util::{api_client, build_clean_test_app_dir, http_client, test_namespace, CommandExt};

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

#[test_log::test(tokio::test)]
async fn test_cli_app_with_private_package() {
    let name = format!(
        "test-appprivpkg-{}",
        uuid::Uuid::new_v4().to_string().replace("-", "")
    );
    let namespace = test_namespace();

    // Create static site app.
    let client = api_client();

    let dir = build_clean_test_app_dir(&name);

    tracing::debug!(local_path=%dir.display(), "creating app with cli");

    std::process::Command::new("wasmer")
        .args(&[
            "app",
            "create",
            "-t",
            "static-website",
            "--non-interactive",
            "--offline",
            "--owner",
            &namespace,
            "--new-package-name",
            &name,
            "--name",
            &name,
            "--path",
            dir.to_str().unwrap(),
        ])
        .status_success()
        .unwrap();

    // Mark package as private.

    let toml_path = dir.join("wasmer.toml");
    let toml_contents = fs_err::read_to_string(&toml_path).expect("Failed to read wasmer.toml");
    let mut manifest =
        toml::from_str::<toml::Value>(&toml_contents).expect("Failed to parse wasmer.toml");
    manifest
        .get_mut("package")
        .expect("no 'package' in toml")
        .as_table_mut()
        .expect("package is not a table")
        .insert("private".to_string(), toml::Value::Boolean(true));
    let toml_contents = toml::to_string(&manifest).expect("Failed to serialize wasmer.toml");
    fs_err::write(&toml_path, toml_contents).expect("Failed to write wasmer.toml");

    // Now publish.

    std::process::Command::new("wasmer")
        .args(&[
            "deploy",
            "--publish-package",
            "--no-persist-id",
            "--owner",
            &namespace,
            "--path",
            dir.to_str().unwrap(),
        ])
        .status_success()
        .unwrap();

    let full_pkg_name = format!("{}/{}", namespace, name);

    // Query the package, make sure it is private.
    let pkg = wasmer_api::query::get_package(&client, full_pkg_name)
        .await
        .expect("could not query package")
        .expect("queried package is None");
    assert_eq!(pkg.private, true, "package should be private");

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
}

/// Test the output of CLI `wasmer app {get,info}`.
#[test_log::test(tokio::test)]
async fn test_cli_app_get_and_info() {
    let name = format!("test-app-cli-info",);
    let namespace = test_namespace();

    // Create static site app.
    let client = api_client();

    let dir = build_clean_test_app_dir(&name);

    tracing::debug!(local_path=%dir.display(), "creating app with cli");

    std::process::Command::new("wasmer")
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
        .status_success()
        .unwrap();

    // Query the app.

    let app = wasmer_api::query::get_app(&client, namespace.clone(), name.clone())
        .await
        .expect("could not query app")
        .expect("queried app is None");
    tracing::debug!("app deployed, sending request");

    let full_name = format!("{}/{}", namespace, name);

    // Check "wasmer app info"

    // With full name.
    let info_output = std::process::Command::new("wasmer")
        .args(&["app", "info", &full_name])
        .output_success()
        .unwrap();

    // With id.
    let info_output2 = std::process::Command::new("wasmer")
        .args(&["app", "info", &app.id.clone().into_inner()])
        .output_success()
        .unwrap();

    assert_eq!(
        info_output.stdout, info_output2.stdout,
        "info output should be the same for full name and id",
    );

    dbg!(&info_output);
    assert!(
        info_output.stdout.contains(&name),
        "info output should contain the app name",
    );
    assert!(
        info_output.stdout.contains(&name),
        "info output should contain the app name",
    );

    // Check "wasmer app get" with default format

    // With full name.
    let get_output = std::process::Command::new("wasmer")
        .args(&["app", "get", &full_name])
        .output_success()
        .expect("could not run 'wasmer app get'");
    dbg!(&get_output);

    // With id.
    let get_output2 = std::process::Command::new("wasmer")
        .args(&["app", "get", &app.id.clone().into_inner()])
        .output_success()
        .expect("could not run 'wasmer app get'");
    assert_eq!(
        get_output.stdout, get_output2.stdout,
        "get output should be the same for full name and id",
    );

    assert!(
        get_output.stdout.contains(&name),
        "get output should contain the app name",
    );
    assert!(
        get_output.stdout.contains(&namespace),
        "get output should contain the app namespace",
    );

    // Check "wasmer app get" with JSON format

    let get_output_json = std::process::Command::new("wasmer")
        .args(&["app", "get", "-f", "json", &full_name])
        .output_success()
        .expect("could not run 'wasmer app get'");
    assert!(
        get_output.stdout.contains(&name),
        "get output should contain the app name",
    );
    assert!(
        get_output.stdout.contains(&namespace),
        "get output should contain the app namespace",
    );

    let json = serde_json::from_str::<serde_json::Value>(&get_output_json.stdout)
        .expect("could not parse 'wasmer app get' output as JSON");

    assert_eq!(
        json.get("id"),
        Some(serde_json::Value::String(app.id.into_inner())).as_ref(),
    );
    assert_eq!(
        json.get("name"),
        Some(serde_json::Value::String(name.clone())).as_ref(),
    );
    assert_eq!(
        json.pointer("/owner/global_name"),
        Some(serde_json::Value::String(namespace.clone())).as_ref(),
    );
}
