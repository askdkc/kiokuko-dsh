use kiokuko_guardrail::digest::sha256;
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "kiokuko-package-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn target() -> String {
    let arch = std::env::consts::ARCH;
    format!(
        "{}-{}",
        arch,
        if cfg!(target_os = "macos") {
            "apple-darwin"
        } else {
            "unknown-linux-gnu"
        }
    )
}
fn build_inputs(version: &str) -> String {
    let h = sha256(b"declared-compiler-fixture");
    format!(
        r#"{{"rustc_version":"{version}","rustc_sha256":"{h}","cargo_version":"fixture","cargo_sha256":"{h}","target":"{}","command":["cargo","build","--release","--locked","--offline"],"source_date_epoch":0}}"#,
        target()
    )
}
fn run(d: &Temp, version: &str, target_name: &str) -> std::process::Output {
    let metadata = d.0.join("inputs.json");
    fs::write(&metadata, build_inputs(version)).unwrap();
    Command::new("python3")
        .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scripts/package.py"))
        .args([
            "--binary",
            env!("CARGO_BIN_EXE_kiokuko-guardrail"),
            "--target",
            target_name,
            "--output",
        ])
        .arg(d.0.join("out"))
        .arg("--build-inputs")
        .arg(metadata)
        .output()
        .unwrap()
}
#[test]
fn packaging_rejects_missing_compiler_identity() {
    let d = Temp::new();
    let o = run(&d, "", &target());
    assert_eq!(o.status.code(), Some(2), "{:?}", o);
}
#[test]
fn archive_is_reproducible_and_version_comes_from_metadata() {
    let d = Temp::new();
    let o = run(&d, "rustc-fixture", &target());
    assert!(o.status.success(), "{:?}", o);
    let n = format!(
        "kiokuko-guardrail-{}-{}.tar.gz",
        env!("CARGO_PKG_VERSION"),
        target()
    );
    let archive = d.0.join("out").join(&n);
    let first = fs::read(&archive).unwrap();
    let o = run(&d, "rustc-fixture", &target());
    assert!(o.status.success());
    assert_eq!(first, fs::read(&archive).unwrap());
    let manifest = fs::read_to_string(d.0.join("out").join(format!("{n}.manifest.json"))).unwrap();
    assert!(manifest.contains(&format!("\"version\": \"{}\"", env!("CARGO_PKG_VERSION"))));
    assert!(manifest.contains("source_sha256"));
    let digest = fs::read_to_string(d.0.join("out").join(format!("{n}.sha256"))).unwrap();
    assert!(digest.starts_with(&sha256(&first)));
}
#[test]
fn wrong_architecture_or_os_never_packaged() {
    let d = Temp::new();
    let wrong = if cfg!(target_os = "macos") {
        "x86_64-unknown-linux-gnu"
    } else {
        "aarch64-apple-darwin"
    };
    assert_eq!(run(&d, "rustc-fixture", wrong).status.code(), Some(2));
}
