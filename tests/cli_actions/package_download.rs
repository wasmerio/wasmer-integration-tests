use assert_cmd::Command;
use tempfile::TempDir;
use uuid::Uuid;
use watest::{mkdir, TestEnv};

#[test_log::test(tokio::test)]
async fn test_package_download_named() {
    let dir = TempDir::new().unwrap();
    let path = dir.path();

    let TestEnv { namespace, .. } = watest::env();
    let name = format!("a{}", Uuid::new_v4().to_string());
    let full_name = format!("{}/{}", namespace, name);

    mkdir!(path; {
        "wasmer.toml" => format!(r#"
            [package]
            name = "{full_name}"
            version = "0.1.0"

            [fs]
            "data" = "./data"
        "#),

        "data" => {
            "a.txt" => "a",
            "b" => {
                "b.md" => "# b",
            }
        }
    });

    // Publish package.
    Command::new("wasmer")
        .arg("publish")
        .current_dir(&dir)
        .assert()
        .success();

    // Download the package.
    Command::new("wasmer")
        .args(&["package", "download", &full_name, "-o", "out.webc"])
        .current_dir(&dir)
        .assert()
        .success();

    // Unpack.
    Command::new("wasmer")
        .args(&["container", "unpack", "out.webc", "-o", "out"])
        .current_dir(&dir)
        .assert()
        .success();

    assert_eq!(
        std::fs::read_to_string(path.join("out/atom/data/a.txt")).unwrap(),
        "a"
    );
    assert_eq!(
        std::fs::read_to_string(path.join("out/atom/data/b/b.md")).unwrap(),
        "# b"
    );
}
#[ignore]
#[test_log::test(tokio::test)]
async fn test_package_download_unnamed() {
    let dir = TempDir::new().unwrap();
    let path = dir.path();
    let TestEnv { namespace, .. } = watest::env();

    mkdir!(dir.path(); {
        "wasmer.toml" => format!(r#"
            [fs]
            "data" = "./data"
        "#),

        "data" => {
            "a.txt" => "a",
            "b" => {
                "b.md" => "# b",
            }
        }
    });

    // Push the package.
    let output = Command::new("wasmer")
        .args(&["package", "push", "--namespace", &namespace])
        .current_dir(&dir)
        .assert()
        .success()
        .get_output()
        .clone();
    let stderr = String::from_utf8(output.stderr).expect("stderr is not utf8");

    // Parse the hash from the output.
    let (_, rest) = stderr.split_once("sha256:").expect("no hash in output");
    let hash = rest.chars().take(64).collect::<String>();
    eprintln!("hash: {}", hash);

    // Download the package.
    Command::new("wasmer")
        .args(&[
            "package",
            "download",
            &format!("sha256:{}", hash),
            "-o",
            "out.webc",
        ])
        .current_dir(&dir)
        .assert()
        .success();
    assert!(path.join("out.webc").exists());

    // Unpack the package.
    Command::new("wasmer")
        .args(&["container", "unpack", "out.webc", "-o", "out"])
        .current_dir(&dir)
        .assert()
        .success();

    // FIXME: currently uses the wrong webc version , resulting in an unexpected
    // directory layout. Backend returns v3 or we switch to v3 in general
    //
    assert_eq!(
        std::fs::read_to_string(path.join("out/atom/data/a.txt")).unwrap(),
        "a"
    );
    assert_eq!(
        std::fs::read_to_string(path.join("out/atom/data/b/b.md")).unwrap(),
        "# b"
    );
}
