use clap::Parser;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    std::env::set_var("RUST_LOG", "watest=trace,info");
    tracing_subscriber::fmt::init();
    let args = Cmd::parse();
    watest::util::mirror_package(
        args.namespace,
        args.package,
        args.source_registry,
        args.target_registry,
        args.token,
    )
    .await
    .unwrap();
}

#[derive(clap::Parser)]
struct Cmd {
    #[clap(long)]
    source_registry: url::Url,

    #[clap(long, env = "WASMER_REGISTRY")]
    target_registry: url::Url,

    #[clap(long, env = "WASMER_TOKEN")]
    token: String,

    #[clap(long)]
    namespace: String,

    #[clap(long)]
    package: String,
}
