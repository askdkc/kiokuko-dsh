use kiokuko_guardrail::digest::sha256;
use kiokuko_guardrail::eval::{eval, render, Env, NoHost, Value};
use kiokuko_guardrail::host::EvidenceSnapshot;
use kiokuko_guardrail::protocol::{check_phase, compile, fingerprint};
use kiokuko_guardrail::{read, Error, ErrorKind, Expr, Limits};
use std::{fs::OpenOptions, io::Read, path::Path};
fn file_bytes(path: &Path, max: usize) -> Result<Vec<u8>, Error> {
    // Inspect before opening, then use nonblocking/no-follow and inspect the actual
    // descriptor too. This rejects FIFOs without waiting for a writer.
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|e| Error::new(ErrorKind::Host, format!("cannot inspect input: {e}")))?;
    if !metadata.file_type().is_file() {
        return Err(Error::new(
            ErrorKind::Host,
            "only regular non-symlink input files are supported",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Linux asm-generic/fcntl.h; Apple XNU bsd/sys/fcntl.h.
        #[cfg(target_os = "linux")]
        const FLAGS: i32 = 0o4000 | 0o400000;
        #[cfg(target_os = "macos")]
        const FLAGS: i32 = 0x0004 | 0x0100;
        options.custom_flags(FLAGS);
    }
    let f = options
        .open(path)
        .map_err(|e| Error::new(ErrorKind::Host, format!("cannot open input: {e}")))?;
    if !f
        .metadata()
        .map_err(|e| Error::new(ErrorKind::Host, e.to_string()))?
        .is_file()
    {
        return Err(Error::new(
            ErrorKind::Host,
            "only regular input files are supported",
        ));
    }
    let mut bytes = Vec::new();
    f.take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| Error::new(ErrorKind::Host, e.to_string()))?;
    if bytes.len() > max {
        return Err(Error::new(ErrorKind::ResourceLimit, "file byte limit"));
    }
    Ok(bytes)
}
fn input(path: &str) -> Result<String, Error> {
    String::from_utf8(file_bytes(Path::new(path), Limits::default().input_bytes)?)
        .map_err(|_| Error::new(ErrorKind::Syntax, "input must be UTF-8"))
}
fn strv(s: &str) -> String {
    render(&Value::Str(s.into()))
}
fn execute(args: &[String]) -> Result<i32, Error> {
    let limits = Limits::default();
    match args{
        [flag]if flag=="--version"=>{println!("kiokuko-guardrail {}",env!("CARGO_PKG_VERSION"));Ok(0)},
        [command,source]if command=="eval"=>{
            let forms=read(source,limits)?;if forms.len()!=1{return Err(Error::new(ErrorKind::Syntax,"eval requires one expression"));}
            println!("{}",render(&eval(&forms[0],&Env::new(),&NoHost,limits)?));Ok(0)
        },
        [command,path]if command=="read"=>{
            let forms=read(&input(path)?,limits)?;
            for form in forms{println!("{}",render(&eval(&Expr::Quote(Box::new(form)),&Env::new(),&NoHost,limits)?));}Ok(0)
        },
        [command,path]if command=="validate"=>{
            let protocol=compile(&read(&input(path)?,limits)?,&EvidenceSnapshot::empty(),limits)?;
            println!("(protocol :name {} :phases {} :protocol-sha256 {})",strv(&protocol.name),protocol.phases.len(),strv(&fingerprint(&protocol)));Ok(0)
        },
        [command,path,phase,evidence_path]if command=="check"=>{
            let captured=input(evidence_path)?;let snapshot=EvidenceSnapshot::parse(&captured,limits)?;
            let protocol=compile(&read(&input(path)?,limits)?,&snapshot,limits)?;
            let allowed=check_phase(&protocol,phase,&snapshot.env(),&snapshot,limits)?;
            let p=protocol.phases.iter().find(|p|&p.name==phase).expect("checked phase exists");
            let next=if allowed{p.next.as_str()}else{p.on_violation.as_deref().unwrap_or(phase)};
            let exe=std::env::current_exe().map_err(|e|Error::new(ErrorKind::Host,e.to_string()))?;
            let engine_digest=sha256(&file_bytes(&exe,64*1024*1024)?);
            println!("(decision :allow {} :phase {} :next {} :task {} :issuer {} :authority-revision {} :protocol-sha256 {} :evidence-sha256 {} :engine-version {} :engine-sha256 {})",if allowed{"t"}else{"nil"},strv(phase),strv(next),strv(&snapshot.task),strv(&snapshot.issuer),snapshot.revision,strv(&fingerprint(&protocol)),strv(&sha256(captured.as_bytes())),strv(env!("CARGO_PKG_VERSION")),strv(&engine_digest));
            Ok(if allowed{0}else{3})
        },
        _=>Err(Error::new(ErrorKind::Syntax,"usage: kiokuko-guardrail --version | read FILE | eval EXPR | validate PROTOCOL | check PROTOCOL PHASE EVIDENCE")),
    }
}
fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let code = match execute(&args) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("{e}");
            if e.kind == ErrorKind::ResourceLimit {
                4
            } else {
                2
            }
        }
    };
    std::process::exit(code);
}
