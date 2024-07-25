use std::env;

use tempfile::TempDir;
use uuid::Uuid;
use watest::{http_client, mkdir};

#[test_log::test(tokio::test)]
#[ignore = "reason"]
async fn test_php_extensions() {
    let dir = TempDir::new().unwrap();
    let path = dir.path();
    let watest::TestEnv {
        registry,
        namespace,
        app_domain,
    } = watest::env();

    let name = format!("test-{}", Uuid::new_v4());
    let domain = format!("{name}.{app_domain}");

    let pkg_dir = watest::manifest_dir()
        .join("fixtures")
        .join("php-extensions")
        .to_str()
        .unwrap()
        .to_string();

    // mandatory env vars
    let mut env_vars = [
        "PG_HOST",
        "PG_DBNAME",
        "PG_USERNAME",
        "PG_PASSWORD",
        "MYSQL_HOST",
        "MYSQL_DBNAME",
        "MYSQL_USERNAME",
        "MYSQL_PASSWORD",
    ]
    .iter()
    .map(|v| format!("  {v}: \"{}\"", env::var(v).unwrap()))
    .collect::<Vec<_>>();

    // optional env vars
    for v in ["PG_PORT", "MYSQL_PORT"] {
        if let Ok(val) = env::var(v) {
            env_vars.push(format!("  {v}: \"{val}\""));
        }
    }

    // The certificate file can be a multi-line value, so it needs special handling
    if let Ok(val) = env::var("MYSQL_CERT") {
        env_vars.push("  MYSQL_CERT: |\n".to_string());
        for line in val.lines() {
            env_vars.push(format!("    {line}"));
        }
    }

    let env_vars = env_vars.join("\n");

    mkdir!(path; {
        "app.yaml" => format!(r#"
kind: wasmer.io/App.v0
name: {name}
owner: {namespace}
package: {pkg_dir}
debug: true
env:
{env_vars}
domains:
  - {domain}
"#),
    });

    assert_cmd::Command::new("wasmer")
        .args([
            "deploy",
            "--non-interactive",
            "--no-wait",
            "--registry",
            registry.as_ref(),
        ])
        .current_dir(&dir)
        .assert()
        .success();

    let url = format!("https://{domain}/");

    eprintln!("fetching url {url}");

    let mut failures = vec![];

    let client = http_client();

    if let Some(fail) = run_test(&client, &url, "curl").await {
        failures.push(("curl", fail));
    }

    if let Some(fail) = run_test(&client, &url, "mail").await {
        failures.push(("mail", fail));
    }

    if let Some(fail) = run_test(&client, &url, "mysql").await {
        failures.push(("mysql", fail));
    }

    if let Some(fail) = run_test(&client, &url, "pgsql").await {
        failures.push(("pgsql", fail));
    }

    if !failures.is_empty() {
        for (test, fail) in failures {
            eprintln!("Test {test} failed with {fail}");
        }
        panic!("Failures detected");
    }
}

async fn run_test(client: &reqwest::Client, url: &str, test: &str) -> Option<String> {
    let res = client
        .get(&format!("{url}?test={test}"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();

    let text = res.text().await.unwrap();
    if text == "Success" {
        None
    } else {
        Some(text)
    }
}
