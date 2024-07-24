use std::fs::{create_dir, write};
use tempfile::TempDir;
use watest::{deploy_dir, env, get_random_app_name, send_get_request_to_app};

#[test_log::test(tokio::test)]
async fn test_python_wcgi() {
    let dir = TempDir::new().unwrap().into_path();
    let name = get_random_app_name();
    write(
        dir.join("wasmer.toml"),
        format!(
            r#"
[dependencies]
"wasmer/python" = "*"

[fs]
"/src" = "./src"

[[command]]
name = "script"
module = "wasmer/python:python"
runner = "https://webc.org/runner/wcgi"
[command.annotations.wasi]
main-args = ["src/main.py"]
    "#
        ),
    )
    .unwrap();
    write(
        dir.join("app.yaml"),
        format!(
            r#"
kind: wasmer.io/App.v0
name: {name}
owner: wasmer-integration-tests
package: .
    "#
        ),
    )
    .unwrap();
    create_dir(dir.join("src")).unwrap();
    write(
        dir.join("src/main.py"),
        r#"
print("HTTP/1.1 200 OK\r")
print("Content-Type: text/html\r")
print("\r")
print("<html><body><h1>Hello, World!</h1></body></html>\r")
print("\r")
"#,
    )
    .unwrap();

    deploy_dir(&dir);

    let body = send_get_request_to_app(&name).await.text().await.unwrap();
    assert!(body.contains("Hello, World!"), "{body}");
}
#[test_log::test(tokio::test)]
async fn test_winterjs() {
    let dir = TempDir::new().unwrap().into_path();
    let name = get_random_app_name();
    write(
        dir.join("wasmer.toml"),
        format!(
            r#"
[dependencies]
"wasmer/winterjs" = "*"
[fs]
"/src" = "./src"
    "#
        ),
    )
    .unwrap();
    write(
        dir.join("app.yaml"),
        format!(
            r#"
kind: wasmer.io/App.v0
name: {name}
owner: wasmer-integration-tests
package: .
cli_args:
- /src/main.js
    "#
        ),
    )
    .unwrap();
    create_dir(dir.join("src")).unwrap();
    write(
        dir.join("src/main.js"),
        r#"
addEventListener('fetch', (req) => {
    req.respondWith(new Response('Hello World!'));
});
"#,
    )
    .unwrap();

    deploy_dir(&dir);

    let body = send_get_request_to_app(&name).await.text().await.unwrap();
    assert!(body.contains("Hello World!"), "{body}");
}

#[test_log::test(tokio::test)]
async fn test_php() {
    let dir = TempDir::new().unwrap().into_path();
    let name = get_random_app_name();
    write(
        dir.join("wasmer.toml"),
        format!(
            r#"
[dependencies]
"php/php" = "*"

[fs]
"/src" = "src"

[[command]]
name = "run"
module = "php/php:php"
runner = "wasi"
[command.annotations.wasi]
main-args = ["-t", "/src", "-S", "localhost:8080"]
"#
        ),
    )
    .unwrap();
    write(
        dir.join("app.yaml"),
        format!(
            r#"
kind: wasmer.io/App.v0
name: {name}
owner: wasmer-integration-tests
package: .
    "#
        ),
    )
    .unwrap();
    create_dir(dir.join("src")).unwrap();
    write(
        dir.join("src/index.php"),
        r#"
<?
echo $_GET["name"];
?>
"#,
    )
    .unwrap();

    deploy_dir(&dir);
    let app_domain = env().app_domain;
    let response = reqwest::Client::new()
        .get(format!(
            "https://{name}-wasmer-integration-tests.{app_domain}"
        ))
        .query(&[("name", &name)])
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    println!("{response}");
    assert!(response.contains(&name));
}

#[test_log::test(tokio::test)]
async fn wasmer_build_deploy_axum() {
    let dir = TempDir::new().unwrap().into_path();
    let name = get_random_app_name();
    write(
        dir.join("app.yaml"),
        format!(
            r#"
kind: wasmer.io/App.v0
name: {name}
owner: wasmer-integration-tests
package: wasmer-integration-tests/axum
    "#
        ),
    )
    .unwrap();
    deploy_dir(&dir);
    let app_domain = env().app_domain;
    assert!(reqwest::Client::new()
        .get(format!(
            "https://{name}-wasmer-integration-tests.{app_domain}"
        ))
        .query(&[("name", &name)])
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap()
        .contains(&name));
}
