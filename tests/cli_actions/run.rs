use std::process::Command;

#[test_log::test(tokio::test)]
async fn test_run() {
    assert!(
        String::from_utf8(
            Command::new("wasmer")
                .args(["run", "wasmer/python", "--", "-c", "print(1+1)"])
                .output()
                .unwrap()
                .stdout
        )
        .unwrap()
            == "2\n"
    );
}
