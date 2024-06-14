use std::process::Command;

#[test_log::test(tokio::test)]
async fn test_ssh() {
    assert_eq!(
        "/",
        String::from_utf8(
            Command::new("wasmer")
                .args(["ssh", "sharrattj/bash", "--", "-c", "pwd"])
                .output()
                .unwrap()
                .stdout
        )
        .unwrap()
        .trim()
    );
    assert_eq!(
        "/",
        String::from_utf8(
            Command::new("sh")
                .args(["-c", "echo pwd | wasmer ssh"])
                .output()
                .unwrap()
                .stdout
        )
        .unwrap()
        .trim()
    );
    assert!(String::from_utf8(
        Command::new("wasmer")
            .args(["ssh", "sharrattj/bash", "--", "-c", "ls"])
            .output()
            .unwrap()
            .stdout
    )
    .unwrap()
    .trim()
    .split_ascii_whitespace()
    .any(|e| e == "bin"));
    assert_eq!(
        "/test",
        String::from_utf8(
            Command::new("sh")
                .args(["-c", "echo 'mkdir test && cd test && pwd' | wasmer ssh"])
                .output()
                .unwrap()
                .stdout
        )
        .unwrap()
        .trim()
    );
    assert_eq!(
        "hello",
        String::from_utf8(
            Command::new("sh")
                .args(["-c", "echo 'echo -n hello > test && cat test' | wasmer ssh"])
                .output()
                .unwrap()
                .stdout
        )
        .unwrap()
        .trim()
    );
}
