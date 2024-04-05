use crate::util::{
    api_client, build_clean_test_app_dir, http_client, mirror_package_prod_to_local,
    test_namespace, wait_app_latest_version, CommandExt,
};

/// Test that an app can make http requests to both ipv4 and ipv6 servers.
#[test_log::test(tokio::test)]
async fn test_winterjs_http_proxy_ipv4_v6() {
    mirror_package_prod_to_local("wasmer", "winterjs")
        .await
        .unwrap();

    let name = "wasmer-test-winterjs-proxy-netw".to_string();
    let namespace = test_namespace();

    let dir = build_clean_test_app_dir(&name);

    let pkgtoml = format!(
        r#"
[package]
name = "{namespace}/{name}"
version = "0.1.0"
description = "wasmer-tests/winterjs-proxy js worker"

[dependencies]
"wasmer/winterjs" = "*"

[fs]
"/src" = "./src"

[[command]]
name = "script"
module = "wasmer/winterjs:winterjs"
runner = "https://webc.org/runner/wasi"

[command.annotations.wasi]
env = ["JS_PATH=/src/index.js"]
main-args = ["/src/index.js"]
"#
    );

    let appyaml = format!(
        r#"
---
kind: wasmer.io/App.v0
name: {name}
owner: {namespace}
package: {namespace}/{name}
cli_args:
  - /src/index.js
domains:
  - {name}.wasmer.app
debug: false
"#
    );

    let js = r#"
// Handler function.
// Receives a request and returns a response.
async function handleRequest(ev) {
  const request = ev.request;

  const url = new URL(request.url);
  const path = url.pathname.slice(1);
  if (path === '/') {
    return new Response(JSON.stringify({message: "need to provide a url in the path"}));
  }

  let res;
  try {
    console.log('sending fetch request', {url: path});
    res = await fetch(path);
    console.log('response', {url: res.url, status: res.status});
  } catch (err) {
    res = new Response(JSON.stringify({ error: err.message }), {
      status: 500,
    });
  }

  return res;
}

// Register the listener that handles incoming requests.
addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event));
});
"#;

    let srcdir = dir.join("src");
    fs_err::create_dir_all(&srcdir).expect("Failed to create src dir");

    fs_err::write(dir.join("wasmer.toml"), pkgtoml).expect("Failed to write to wasmer.toml");
    fs_err::write(dir.join("app.yaml"), appyaml).expect("Failed to write to app.yaml");
    fs_err::write(srcdir.join("index.js"), js).expect("Failed to write to index.js");

    // Deploy the app.
    std::process::Command::new("wasmer")
        .args(&[
            "deploy",
            "--no-wait",
            "--publish-package",
            "--path",
            dir.to_str().unwrap(),
        ])
        .status_success()
        .expect("Failed to invoke 'wasmer deploy'");

    // Query the app.

    let api = api_client();

    let app = wasmer_api::query::get_app(&api, namespace.clone(), name.clone())
        .await
        .expect("could not query app")
        .expect("queried app is None");

    let client = http_client();
    wait_app_latest_version(&client, &app)
        .await
        .expect("Failed to wait for app latest version");

    tracing::debug!("app deployed, sending request");

    let mut url = app
        .url
        .parse::<url::Url>()
        .expect("Failed to parse app URL");

    // test v4
    url.set_path("http://v4.ipv6test.app/");
    let res = crate::util::build_app_request_get(&client, &app, url.clone())
        .send()
        .await
        .expect("Failed to send request")
        .error_for_status()
        .expect("Failed to get response");
    let body = res.text().await.expect("Failed to get response body");
    // Should have returned a valid ipv4 address.
    let _ip = body
        .parse::<std::net::Ipv4Addr>()
        .expect("body did not contain a valid ip address");

    // Test v6
    url.set_path("http://v6.ipv6test.app/");
    let res = crate::util::build_app_request_get(&client, &app, url.clone())
        .send()
        .await
        .expect("Failed to send request")
        .error_for_status()
        .expect("Failed to get response");
    let body = res.text().await.expect("Failed to get response body");
    // Should have returned a valid ipv6 address.
    let _ip = body
        .parse::<std::net::Ipv6Addr>()
        .expect("body did not contain a valid ip address");
}
