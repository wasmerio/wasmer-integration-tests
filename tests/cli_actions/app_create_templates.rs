//! Test the various available templates.
//!
//! Note: to avoid having to mirror the templates, the apps are created
//! from the prod registry, but deployed to the dev registry.

use watest::{TestEnv, REGISTRY_PROD};

#[test_log::test(tokio::test)]
#[ignore = "disabled until ci's have prod key"]
async fn test_app_template_static_site() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();

    let TestEnv {
        namespace,
        app_domain,
        ..
    } = watest::env();

    let name = format!("t-{}", uuid::Uuid::new_v4());
    let domain = format!("{}.{}", name, app_domain);
    let url = format!("https://{}", domain);

    assert_cmd::Command::new("wasmer")
        .args(&[
            "app",
            "create",
            "--non-interactive",
            "--registry",
            REGISTRY_PROD,
            "--owner",
            &namespace,
            "--template",
            "static-website",
            "--name",
            &name,
        ])
        .current_dir(&path)
        .assert()
        .success();

    let app_yaml_path = path.join("app.yaml");
    let mut app_yaml = std::fs::read_to_string(&app_yaml_path).unwrap();
    app_yaml.push_str(&format!("\ndomains: [\"{domain}\"]"));
    std::fs::write(&app_yaml_path, app_yaml).unwrap();

    assert_cmd::Command::new("wasmer")
        .args(&["deploy", "--non-interactive"])
        .current_dir(&path)
        .assert()
        .success();

    let response = reqwest::get(&url).await.unwrap();
    assert!(response.status().is_success());
    let body = response.text().await.unwrap();
    assert!(body.contains("Hi from the Edge"));
}
