use std::env::temp_dir;
use std::fs::write;
use std::net::Ipv4Addr;
use std::process::Command;
use std::thread::sleep;
use std::time::Duration;

use fs_err::create_dir;
use rustdns::clients::udp::Client;
use rustdns::clients::Exchanger;
use rustdns::types::*;
use uuid::Uuid;

use crate::util::publish_local_package;

#[test_log::test(tokio::test)]
async fn test_dns() {
    publish_local_package("../packages/static-web-server");
    publish_local_package("../packages/test-app");

    let app_name = &Uuid::new_v4().to_string();
    let app_dir = &temp_dir().join(app_name);
    create_dir(app_dir).unwrap();
    assert!(Command::new("wasmer")
        .args([
            "app",
            "create",
            "--package",
            "cypress1/test-app",
            "--owner",
            "wasmer-tests",
            "--no-wait",
            "--type",
            "static-website",
            "--name",
            app_name.as_str(),
            "--non-interactive",
            "--registry",
            "http://127.0.0.1:8080/graphql",
            "--token",
            std::env::var("WASMER_TOKEN").unwrap_or("wap_default_token".to_string()).as_str(),
        ])
        .current_dir(app_dir)
        .status()
        .unwrap()
        .success());

    let http_client = reqwest::Client::new();
    let mut app_running = false;
    for _ in 1..20 {
        let response = http_client
            .get("http://127.0.0.1")
            .header("Host", format!("{}-wasmer-tests.wasmer.app", app_name))
            .send()
            .await
            .unwrap();
        if response.status().is_success() {
            app_running = true;
            break;
        }
        sleep(Duration::from_secs(5));
    }
    assert!(app_running);
    let domain = format!("{}.com", app_name.clone().get(..10).unwrap());
    println!("{}", domain);
    assert!(Command::new("wasmer")
        .args([
            "domain",
            "register",
            &domain,
            "--registry",
            std::env::var("WASMER_REGISTRY").unwrap_or("http://127.0.0.1:8080/graphql".to_string()).as_str(),
            "--token",
            std::env::var("WASMER_TOKEN").unwrap_or("wap_default_token".to_string()).as_str(),
        ])
        .status()
        .unwrap()
        .success());
    let get_zone_file = Command::new("wasmer")
        .args([
            "domain",
            "get-zone-file",
            &domain,
            "--registry",
            std::env::var("WASMER_REGISTRY").unwrap_or("http://127.0.0.1:8080/graphql".to_string()).as_str(),
            "--token",
            std::env::var("WASMER_TOKEN").unwrap_or("wap_default_token".to_string()).as_str(),
        ])
        .output()
        .unwrap();
    assert!(get_zone_file.status.success());

    let zonefile_path = app_dir.join("zonefile");
    println!("{}", zonefile_path.to_str().unwrap());
    write(
        &zonefile_path,
        String::from_utf8(get_zone_file.stdout).unwrap() + "$TTL 3600\n" + "again IN A 192.168.1.1",
    )
    .unwrap();
    assert!(Command::new("wasmer")
        .args([
            "domain",
            "sync-zone-file",
            &zonefile_path.to_str().unwrap(),
            "--registry",
            std::env::var("WASMER_REGISTRY").unwrap_or("http://127.0.0.1:8080/graphql".to_string()).as_str(),
            "--token",
            std::env::var("WASMER_TOKEN").unwrap_or("wap_default_token".to_string()).as_str(),
        ])
        .status()
        .unwrap()
        .success());
    // Wait until edge fetches dns records from backend
    sleep(Duration::from_secs(5));
    let mut query = Message::default();
    query.add_question(&format!("again.{}", domain), Type::A, Class::Internet);

    let client = Client::new("127.0.0.1:53").unwrap();
    let resp = client.exchange(&query).unwrap();
    assert!(resp.rcode == Rcode::NoError);
    assert!(resp
        .answers
        .iter()
        .any(|record| record.resource == Resource::A(Ipv4Addr::new(192, 168, 1, 1))));
}
