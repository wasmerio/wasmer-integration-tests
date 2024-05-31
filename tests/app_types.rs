use std::fs::{create_dir, write};
use tempfile::TempDir;
use uuid::Uuid;
use watest::{deploy_dir, send_get_request_to_app};

#[ignore = "python wcgi broken on wasmer"]
#[test_log::test(tokio::test)]
async fn test_python_wcgi() {
    let dir = TempDir::new().unwrap().into_path();
    let name = Uuid::new_v4().to_string();
    write(
        dir.join("wasmer.toml"),
        format!(
            r#"
[dependencies]
"wasmer/python" = "3"

[fs]
"/main.py" = "./main.py"

[[command]]
name = "script"
module = "wasmer/python:python"
runner = "https://webc.org/runner/wcgi"
[command.annotations.wasi]
main-args = ["/main.py"]
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
owner: wasmer-tests
package: .
cli_args:
- /main.py
    "#
        ),
    )
    .unwrap();

    write(
        dir.join("main.py"),
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
    assert!(body.contains("Hello World!"), "{body}");
}

#[test_log::test(tokio::test)]
async fn test_winterjs() {
    let dir = TempDir::new().unwrap().into_path();
    let name = Uuid::new_v4().to_string();
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
owner: wasmer-tests
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
    let name = Uuid::new_v4().to_string();
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
owner: wasmer-tests
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

    assert!(reqwest::Client::new()
        .get(format!("https://{name}-wasmer-tests.wasmer.dev"))
        .query(&[("name", &name)])
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap()
        .contains(&name));
}

#[test_log::test(tokio::test)]
async fn wasmer_build_deploy_axum() {
    let dir = TempDir::new().unwrap().into_path();
    let name = Uuid::new_v4().to_string();
    write(
        dir.join("app.yaml"),
        format!(
            r#"
kind: wasmer.io/App.v0
name: {name}
owner: wasmer-tests
package: wasmer-tests/axum
    "#
        ),
    )
    .unwrap();
    deploy_dir(&dir);
    assert!(reqwest::Client::new()
        .get(format!("https://{name}-wasmer-tests.wasmer.dev"))
        .query(&[("name", &name)])
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap()
        .contains(&name));
}
