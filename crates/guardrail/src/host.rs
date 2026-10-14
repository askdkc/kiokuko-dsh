//! Read-only adapter for evidence snapshots produced by the existing authority.
//! The snapshot is NOT a signature or a proof that the submitting caller is trusted.
use crate::eval::{Env, HostQuery, HostValue, QuerySpec, Value};
use crate::{read, Error, ErrorKind, Expr, Limits};
use std::collections::{BTreeMap, BTreeSet};
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    AssertionFailure,
    Passed,
    SyntaxError,
    Timeout,
    SetupError,
    Signaled,
    Skipped,
    NotRun,
    Produced,
}
#[derive(Clone, Debug)]
pub struct Record {
    pub name: String,
    pub id: String,
    pub digest: String,
    pub generation: u64,
    pub outcome: Outcome,
    pub exit: i64,
    pub assertions: u64,
    pub status: String,
}
#[derive(Clone, Debug)]
pub struct EvidenceSnapshot {
    pub issuer: String,
    pub task: String,
    pub revision: u64,
    pub input_digests: BTreeMap<String, String>,
    pub model_provider: String,
    pub model_name: String,
    pub records: BTreeMap<String, Record>,
}
fn bad(message: impl Into<String>) -> Error {
    Error::new(ErrorKind::Host, message)
}
fn fields<'a>(xs: &'a [Expr], expected: &[&str]) -> Result<BTreeMap<&'a str, &'a Expr>, Error> {
    if xs.len() != expected.len() * 2 {
        return Err(bad("snapshot fields are missing or excessive"));
    }
    let mut map = BTreeMap::new();
    for pair in xs.chunks_exact(2) {
        let key = match &pair[0] {
            Expr::Keyword(s) => s.as_str(),
            _ => return Err(bad("snapshot field must be a keyword")),
        };
        if !expected.contains(&key) || map.insert(key, &pair[1]).is_some() {
            return Err(bad("unknown or duplicate snapshot field"));
        }
    }
    Ok(map)
}
fn text(x: &Expr) -> Result<String, Error> {
    match x {
        Expr::Str(s) if !s.is_empty() && s.len() <= 1024 && !s.contains('\0') => Ok(s.clone()),
        _ => Err(bad("expected bounded nonempty text")),
    }
}
fn integer(x: &Expr) -> Result<i64, Error> {
    match x {
        Expr::Int(n) => Ok(*n),
        _ => Err(bad("expected integer")),
    }
}
fn positive(x: &Expr) -> Result<u64, Error> {
    let n = integer(x)?;
    if n <= 0 {
        return Err(bad("expected positive integer"));
    }
    Ok(n as u64)
}
fn keyword(x: &Expr) -> Result<String, Error> {
    match x {
        Expr::Keyword(s) => Ok(s.clone()),
        _ => Err(bad("expected keyword")),
    }
}
fn digest(x: &Expr) -> Result<String, Error> {
    let s = text(x)?;
    if s.len() != 64
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(bad("expected lowercase SHA-256 digest"));
    }
    Ok(s)
}
fn sequence(x: &Expr) -> Result<&[Expr], Error> {
    match x {
        Expr::List(xs) => Ok(xs),
        Expr::Nil => Ok(&[]),
        _ => Err(bad("expected proper evidence list")),
    }
}
impl EvidenceSnapshot {
    pub fn parse(input: &str, limits: Limits) -> Result<Self, Error> {
        let forms = read(input, limits)?;
        if forms.len() != 1 {
            return Err(bad("exactly one evidence snapshot required"));
        }
        let xs = sequence(&forms[0])?;
        if xs.is_empty() || !matches!(&xs[0],Expr::Symbol(s)if s=="evidence") {
            return Err(bad("expected evidence declaration"));
        }
        let f = fields(
            &xs[1..],
            &[
                "schema",
                "authority",
                "issuer",
                "task",
                "revision",
                "source",
                "tests",
                "command",
                "runtime",
                "model-provider",
                "model-name",
                "model-parameters",
                "transcript",
                "artifacts",
            ],
        )?;
        if integer(f["schema"])? != 1 || text(f["authority"])? != "kiokuko-dsh" {
            return Err(bad("unsupported evidence schema/authority"));
        }
        let issuer = text(f["issuer"])?;
        if issuer != "kiokuko-dsh:owned-execution:v1" {
            return Err(bad("unsupported evidence issuer"));
        }
        let task = text(f["task"])?;
        let revision = positive(f["revision"])?;
        let mut input_digests = BTreeMap::new();
        for name in [
            "source",
            "tests",
            "command",
            "runtime",
            "model-parameters",
            "transcript",
        ] {
            input_digests.insert(name.to_owned(), digest(f[name])?);
        }
        let model_provider = text(f["model-provider"])?;
        let model_name = text(f["model-name"])?;
        let records_input = sequence(f["artifacts"])?;
        if records_input.len() > 512 {
            return Err(Error::new(ErrorKind::ResourceLimit, "artifact count limit"));
        }
        let mut records = BTreeMap::new();
        let mut ids = BTreeSet::new();
        for item in records_input {
            let xs = sequence(item)?;
            let name = match xs.first() {
                Some(Expr::Symbol(s)) if s != "t" => s.clone(),
                _ => return Err(bad("artifact needs a symbolic binding name")),
            };
            let a = fields(
                &xs[1..],
                &[
                    "id",
                    "digest",
                    "generation",
                    "expected-generation",
                    "source",
                    "tests",
                    "command",
                    "runtime",
                    "outcome",
                    "exit",
                    "assertions",
                    "status",
                ],
            )?;
            let id = text(a["id"])?;
            let artifact_digest = digest(a["digest"])?;
            let generation = positive(a["generation"])?;
            if generation != positive(a["expected-generation"])? || generation > revision {
                return Err(bad("stale artifact generation"));
            }
            for name in ["source", "tests", "command", "runtime"] {
                if digest(a[name])? != input_digests[name] {
                    return Err(bad(
                        "artifact input binding differs from authoritative snapshot",
                    ));
                }
            }
            let outcome = match keyword(a["outcome"])?.as_str() {
                "assertion-failure" => Outcome::AssertionFailure,
                "passed" => Outcome::Passed,
                "syntax-error" => Outcome::SyntaxError,
                "timeout" => Outcome::Timeout,
                "setup-error" => Outcome::SetupError,
                "signaled" => Outcome::Signaled,
                "skipped" => Outcome::Skipped,
                "not-run" => Outcome::NotRun,
                "produced" => Outcome::Produced,
                _ => return Err(bad("unknown evidence outcome")),
            };
            let exit = integer(a["exit"])?;
            let assertions = integer(a["assertions"])?;
            if assertions < 0 || !(-128..=255).contains(&exit) {
                return Err(bad("invalid assertion count or exit code"));
            }
            let coherent = match outcome {
                Outcome::Passed | Outcome::Produced | Outcome::Skipped | Outcome::NotRun => {
                    exit == 0
                }
                Outcome::AssertionFailure => (1..=125).contains(&exit) && exit != 124,
                Outcome::SyntaxError | Outcome::SetupError => exit != 0,
                Outcome::Signaled => (1..=64).contains(&exit),
                Outcome::Timeout => true,
            };
            if !coherent {
                return Err(bad("outcome conflicts with process status"));
            }
            let status = keyword(a["status"])?;
            if !["observed", "applied", "pending", "completed"].contains(&status.as_str()) {
                return Err(bad("unknown artifact status"));
            }
            if records.contains_key(&name) || !ids.insert(id.clone()) {
                return Err(bad("duplicate artifact name or opaque handle"));
            }
            records.insert(
                name.clone(),
                Record {
                    name,
                    id,
                    digest: artifact_digest,
                    generation,
                    outcome,
                    exit,
                    assertions: assertions as u64,
                    status,
                },
            );
        }
        Ok(Self {
            issuer,
            task,
            revision,
            input_digests,
            model_provider,
            model_name,
            records,
        })
    }
    pub fn env(&self) -> Env {
        self.records
            .iter()
            .map(|(name, r)| (name.clone(), Value::Host(HostValue { id: r.id.clone() })))
            .collect()
    }
    fn record(&self, value: &Value) -> Result<&Record, Error> {
        let id = match value {
            Value::Host(h) => &h.id,
            _ => return Err(bad("query requires an opaque evidence handle")),
        };
        self.records
            .values()
            .find(|r| &r.id == id)
            .ok_or_else(|| bad("unknown opaque evidence handle"))
    }
    pub fn empty() -> Self {
        Self {
            issuer: String::new(),
            task: String::new(),
            revision: 0,
            input_digests: BTreeMap::new(),
            model_provider: String::new(),
            model_name: String::new(),
            records: BTreeMap::new(),
        }
    }
}
impl HostQuery for EvidenceSnapshot {
    fn queries(&self) -> Vec<QuerySpec> {
        [
            "fails-p",
            "passes-p",
            "syntax-error-p",
            "timeout-p",
            "skipped-p",
            "exit-code",
            "status",
            "assertions",
        ]
        .iter()
        .map(|name| QuerySpec {
            name: name.to_string(),
            min_args: 1,
            max_args: if *name == "passes-p" { 2 } else { 1 },
        })
        .collect()
    }
    fn call(&self, name: &str, args: &[Value]) -> Result<Value, Error> {
        let first = args
            .first()
            .ok_or_else(|| bad("missing evidence argument"))?;
        let r = self.record(first)?;
        Ok(match name {
            "fails-p" => Value::Bool(r.outcome == Outcome::AssertionFailure && r.assertions > 0),
            "passes-p" => Value::Bool(
                r.outcome == Outcome::Passed
                    && r.assertions > 0
                    && args
                        .iter()
                        .skip(1)
                        .map(|v| self.record(v))
                        .collect::<Result<Vec<_>, _>>()?
                        .iter()
                        .all(|r| r.outcome == Outcome::Produced && r.status == "applied"),
            ),
            "syntax-error-p" => Value::Bool(r.outcome == Outcome::SyntaxError),
            "timeout-p" => Value::Bool(r.outcome == Outcome::Timeout),
            "skipped-p" => Value::Bool(r.outcome == Outcome::Skipped),
            "exit-code" => Value::Int(r.exit),
            "status" => Value::Keyword(r.status.clone()),
            "assertions" => Value::Int(r.assertions as i64),
            _ => return Err(Error::new(ErrorKind::UnsupportedForm, name)),
        })
    }
}
