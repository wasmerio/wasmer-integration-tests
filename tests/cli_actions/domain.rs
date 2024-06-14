use std::fs::write;
use std::net::Ipv4Addr;
use std::process::Command;
use std::thread::sleep;
use std::time::Duration;

use rustdns::clients::udp::Client;
use rustdns::clients::Exchanger;
use rustdns::types::*;
use tempfile::TempDir;
use uuid::Uuid;

#[test_log::test(tokio::test)]
async fn test_dns() {
    let domain = format!("{}.com", Uuid::new_v4().to_string().get(..10).unwrap());
    let temp_dir = TempDir::new().unwrap().into_path();
    assert!(Command::new("wasmer")
        .args(["domain", "register", &domain, "--registry", "wasmer.wtf",])
        .status()
        .unwrap()
        .success());
    let get_zone_file = Command::new("wasmer")
        .args([
            "domain",
            "get-zone-file",
            &domain,
            "--registry",
            "wasmer.wtf",
        ])
        .output()
        .unwrap();
    assert!(get_zone_file.status.success());

    let zonefile_path = temp_dir.join("zonefile");
    write(
        &zonefile_path,
        String::from_utf8(get_zone_file.stdout).unwrap()
            + "$TTL 3600\n"
            + "my_a_record IN A 192.168.1.1",
    )
    .unwrap();
    assert!(Command::new("wasmer")
        .args([
            "domain",
            "sync-zone-file",
            &zonefile_path.to_str().unwrap(),
            "--registry",
            "wasmer.wtf",
        ])
        .status()
        .unwrap()
        .success());
    // Wait until edge fetches dns records from backend
    sleep(Duration::from_secs(5));
    let mut query = Message::default();
    query.add_question(&format!("my_a_record.{}", domain), Type::A, Class::Internet);

    let client = Client::new("alpha.ns.wasmer-dev.network:53").unwrap();
    let resp = client.exchange(&query).unwrap();
    assert!(resp.rcode == Rcode::NoError);
    assert!(resp
        .answers
        .iter()
        .any(|record| record.resource == Resource::A(Ipv4Addr::new(192, 168, 1, 1))));
}
