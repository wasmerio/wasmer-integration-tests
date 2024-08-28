use predicates::{boolean::NotPredicate, str::contains};
use rand::Rng;
use tempfile::TempDir;
use uuid::Uuid;
use watest::mkdir;

fn deploy_app(name: &str, domain: &str) -> anyhow::Result<()> {
    let dir = TempDir::new().unwrap();
    let path = dir.path();
    let watest::TestEnv {
        namespace,
        registry,
        ..
    } = watest::env();
    mkdir!(path; {
"app.yaml" => format!(r#"
kind: wasmer.io/App.v0
name: {name}
owner: {namespace}
package: wasmer-integration-tests/echo-env@0.1.0 
domains:
- {domain}
"#),
    });

    assert_cmd::Command::new("wasmer")
        .args([
            "deploy",
            "--non-interactive",
            &format!("--registry={registry}"),
        ])
        .current_dir(&dir)
        .assert()
        .success();
    Ok(())
}

/// A utility to get a clean (new) app identifier each time the tests run.
fn get_app() -> Option<(String, String)> {
    let watest::TestEnv { app_domain, .. } = watest::env();

    let name = format!("test-{}", Uuid::new_v4());
    let domain = format!("{name}.{app_domain}");
    deploy_app(&name, &domain).ok()?;

    Some((name, domain))
}

/// Create an app secret.
#[test_log::test(tokio::test)]
async fn test_create_app_secret() -> anyhow::Result<()> {
    let watest::TestEnv { namespace, .. } = watest::env();
    let (app_name, app_domain) =
        get_app().ok_or(anyhow::anyhow!("Could not get app identifier!"))?;

    let app_id = format!("{namespace}/{app_name}");
    let mut rng = rand::thread_rng();
    let range = 0..=i32::MAX;

    let secret_name = format!("SECRET_{}", rng.gen_range(range.clone()));
    let secret_value = format!("VALUE_{}", rng.gen_range(range.clone()));

    assert_cmd::Command::new("wasmer")
        .args([
            "app",
            "secrets",
            "create",
            &format!("--app={app_id}"),
            &secret_name,
            &secret_value,
        ])
        .assert()
        .success();

    assert_cmd::Command::new("wasmer")
        .args(["app", "secrets", "list", &format!("--app={app_id}")])
        .assert()
        .success()
        .stdout(contains(&secret_name));

    let url = format!("https://{app_domain}/");
    let res = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();

    let text = res.text().await?;
    assert!(!text.contains(&secret_value));
    assert!(!text.contains(&secret_name));

    // We must re-deploy!

    deploy_app(&app_name, &app_domain)?;

    let res = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();

    let text = res.text().await?;
    assert!(text.contains(&secret_value));
    assert!(text.contains(&secret_name));

    Ok(())
}

/// Update an app secret.
#[test_log::test(tokio::test)]
async fn test_update_app_secret() -> anyhow::Result<()> {
    // Let's first create it.

    let watest::TestEnv {
        namespace,
        registry,
        ..
    } = watest::env();
    let (app_name, app_domain) =
        get_app().ok_or(anyhow::anyhow!("Could not get app identifier!"))?;

    let app_id = format!("{namespace}/{app_name}");
    let mut rng = rand::thread_rng();
    let range = 0..=i32::MAX;

    let secret_value = format!("SECRET_{}", rng.gen_range(range.clone()));
    let secret_name = format!("VALUE_{}", rng.gen_range(range.clone()));

    assert_cmd::Command::new("wasmer")
        .args([
            "app",
            "secrets",
            "create",
            &format!("--app={app_id}"),
            &secret_name,
            &secret_value,
            &format!("--registry={registry}"),
        ])
        .assert()
        .success();

    assert_cmd::Command::new("wasmer")
        .args([
            "app",
            "secrets",
            "list",
            &format!("--app={app_id}"),
            &format!("--registry={registry}"),
        ])
        .assert()
        .success()
        .stdout(contains(&secret_name));

    assert_cmd::Command::new("wasmer")
        .args([
            "app",
            "secrets",
            "reveal",
            &secret_name,
            &format!("--app={app_id}"),
            &format!("--registry={registry}"),
        ])
        .assert()
        .success()
        .stdout(contains(&secret_value));

    let url = format!("https://{app_domain}/");
    let res = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();

    let text = res.text().await?;
    assert!(!text.contains(&secret_value));
    assert!(!text.contains(&secret_name));

    deploy_app(&app_name, &app_domain)?;

    let res = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();

    let text = res.text().await?;
    assert!(text.contains(&secret_value));
    assert!(text.contains(&secret_name));

    // Let's now update it.

    let new_secret_value = format!("SECRET_{}", rng.gen_range(range.clone()));
    assert_cmd::Command::new("wasmer")
        .args([
            "app",
            "secrets",
            "update",
            &format!("--app={app_id}"),
            &secret_name,
            &new_secret_value,
            &format!("--registry={registry}"),
        ])
        .assert()
        .success();

    assert_cmd::Command::new("wasmer")
        .args([
            "app",
            "secrets",
            "list",
            &format!("--app={app_id}"),
            &format!("--registry={registry}"),
        ])
        .assert()
        .success()
        .stdout(contains(&secret_name));

    assert_cmd::Command::new("wasmer")
        .args([
            "app",
            "secrets",
            "reveal",
            &secret_name,
            &format!("--app={app_id}"),
            &format!("--registry={registry}"),
        ])
        .assert()
        .success()
        .stdout(NotPredicate::new(contains(&secret_value)))
        .stdout(contains(&new_secret_value));

    let res = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();

    let text = res.text().await?;
    assert!(text.contains(&secret_value));
    assert!(!text.contains(&new_secret_value));
    assert!(text.contains(&secret_name));

    deploy_app(&app_name, &app_domain)?;

    let res = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();

    let text = res.text().await?;
    assert!(!text.contains(&secret_value));
    assert!(text.contains(&new_secret_value));
    assert!(text.contains(&secret_name));

    Ok(())
}

/// Delete an app secret.
#[test_log::test(tokio::test)]
async fn test_delete_app_secret() -> anyhow::Result<()> {
    // Let's first create it.

    let watest::TestEnv {
        namespace,
        registry,
        ..
    } = watest::env();
    let (app_name, app_domain) =
        get_app().ok_or(anyhow::anyhow!("Could not get app identifier!"))?;

    let app_id = format!("{namespace}/{app_name}");
    let mut rng = rand::thread_rng();
    let range = 0..=i32::MAX;

    let secret_value = format!("SECRET_{}", rng.gen_range(range.clone()));
    let secret_name = format!("VALUE_{}", rng.gen_range(range.clone()));

    assert_cmd::Command::new("wasmer")
        .args([
            "app",
            "secrets",
            "create",
            &format!("--app={app_id}"),
            &secret_name,
            &secret_value,
            &format!("--registry={registry}"),
        ])
        .assert()
        .success();

    assert_cmd::Command::new("wasmer")
        .args([
            "app",
            "secrets",
            "list",
            &format!("--app={app_id}"),
            &format!("--registry={registry}"),
        ])
        .assert()
        .success()
        .stdout(contains(&secret_name));

    let url = format!("https://{app_domain}/");
    let res = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();

    let text = res.text().await?;
    assert!(!text.contains(&secret_value));
    assert!(!text.contains(&secret_name));

    deploy_app(&app_name, &app_domain)?;

    let res = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();

    let text = res.text().await?;
    assert!(text.contains(&secret_value));
    assert!(text.contains(&secret_name));

    // Let's now delete it.
    assert_cmd::Command::new("wasmer")
        .args([
            "app",
            "secrets",
            "delete",
            &format!("--app={app_id}"),
            &secret_name,
            &format!("--registry={registry}"),
            "--non-interactive",
            "--force",
        ])
        .assert()
        .success();

    assert_cmd::Command::new("wasmer")
        .args([
            "app",
            "secrets",
            "list",
            &format!("--app={app_id}"),
            &format!("--registry={registry}"),
        ])
        .assert()
        .success()
        .stdout(NotPredicate::new(contains(&secret_name)));

    let res = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();

    let text = res.text().await?;
    assert!(text.contains(&secret_value));
    assert!(text.contains(&secret_name));

    deploy_app(&app_name, &app_domain)?;
    deploy_app(&app_name, &app_domain)?;

    let res = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();

    let text = res.text().await?;
    assert!(!text.contains(&secret_value));
    assert!(!text.contains(&secret_name));

    Ok(())
}

/// Reveal an app secret.
#[test_log::test(tokio::test)]
async fn test_reveal_app_secret() -> anyhow::Result<()> {
    // Let's first create it.

    let watest::TestEnv {
        namespace,
        registry,
        ..
    } = watest::env();
    let (app_name, _) = get_app().ok_or(anyhow::anyhow!("Could not get app identifier!"))?;

    let app_id = format!("{namespace}/{app_name}");
    let mut rng = rand::thread_rng();
    let range = 0..=i32::MAX;

    let secret_value = format!("SECRET_{}", rng.gen_range(range.clone()));
    let secret_name = format!("VALUE_{}", rng.gen_range(range.clone()));

    assert_cmd::Command::new("wasmer")
        .args([
            "app",
            "secrets",
            "create",
            &format!("--app={app_id}"),
            &secret_name,
            &secret_value,
            &format!("--registry={registry}"),
        ])
        .assert()
        .success();

    assert_cmd::Command::new("wasmer")
        .args([
            "app",
            "secrets",
            "reveal",
            &secret_name,
            &format!("--app={app_id}"),
            &format!("--registry={registry}"),
        ])
        .assert()
        .success()
        .stdout(contains(&secret_value));

    Ok(())
}
