use std::fs::write;
use std::process::Command;
use tempfile::TempDir;
use uuid::Uuid;

#[test_log::test(tokio::test)]
async fn test_publish() {
    let dir = TempDir::new().unwrap().into_path();
    // registry requires package names to start with non number
    let name = format!("a{}", Uuid::new_v4().to_string());
    write(
        dir.join("wasmer.toml"),
        format!(
            r#"
[package]
name = "wasmer-tests/{name}"
version = "0.1.0"
[dependencies]
"wasmer/python" = "3"
    "#
        ),
    )
    .unwrap();

    assert!(Command::new("wasmer")
        .args(["publish", "--registry", "wasmer.wtf",])
        .current_dir(&dir)
        .status()
        .unwrap()
        .success());
    let output = String::from_utf8(
        Command::new("wasmer")
            .args([
                "run",
                "--registry",
                "wasmer.wtf",
                &format!("wasmer-tests/{name}"),
                "--",
                "-c",
                "print('Hello World!')",
            ])
            .current_dir(dir)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    assert!(output.contains("Hello World!"), "output={output}");
}
