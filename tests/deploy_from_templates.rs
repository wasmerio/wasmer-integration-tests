use std::process::Command;

use tempfile::TempDir;
use watest::get_random_app_name;

fn deploy_template(template_name: &str) {
    let name = get_random_app_name();
    let dir = TempDir::new().unwrap().into_path();
    assert!(Command::new("wasmer")
        .args([
            "app",
            "create",
            "--template",
            template_name,
            "--non-interactive",
            "--name",
            &name,
            "--owner",
            "wasmer-integration-tests",
            "--deploy"
        ])
        .current_dir(dir)
        .status()
        .unwrap()
        .success())
}

#[test_log::test(tokio::test)]
async fn php_wasmer_starter() {
    deploy_template("https://github.com/wasmer-examples/php-wasmer-starter")
}
#[ignore = "this requires additional build steps before deploying, will embed docker into test runtime and run the build steps in docker"]
#[test_log::test(tokio::test)]
async fn symfony_wasmer_starter() {
    deploy_template("https://github.com/wasmer-examples/symfony-wasmer-starter")
}
#[ignore = "fails locally due to bug in package upload timeout"]
#[test_log::test(tokio::test)]
async fn wordpress_wasmer_starter() {
    deploy_template("https://github.com/wasmer-examples/wordpress-wasmer-starter")
}
#[ignore = "this requires additional build steps before deploying, will embed docker into test runtime and run the build steps in docker"]
#[test_log::test(tokio::test)]
async fn laravel_wasmer_starter() {
    deploy_template("https://github.com/wasmer-examples/laravel-wasmer-starter")
}
#[test_log::test(tokio::test)]
async fn php_wcgi_starter() {
    deploy_template("https://github.com/wasmer-examples/php-wcgi-starter")
}
