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
    pub worker_generation: String,
    pub protocol_generation: u64,
    pub lease_generation: u64,
    pub provenance: Provenance,
    pub supporting: Vec<String>,
    pub history: Vec<String>,
    pub state_digest: String,
    pub outcome: Outcome,
    pub exit: i64,
    pub assertions: u64,
    pub status: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Provenance {
    ExecutionBacked,
    StateDerived,
    PureEvaluation,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Route {
    Owned,
    Native,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OperationKind {
    Process,
    File,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExecutionState {
    Completed,
    Denied,
    Unknown,
    Prepared,
    Dispatching,
    Running,
    CancelledBeforeDispatch,
    CancelledConfirmed,
}
impl ExecutionState {
    fn unresolved(&self) -> bool {
        matches!(
            self,
            Self::Unknown | Self::Prepared | Self::Dispatching | Self::Running
        )
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExecutionOutcome {
    Succeeded,
    Failed,
    None,
}
#[derive(Clone, Debug)]
pub struct Execution {
    pub id: String,
    pub scope: String,
    pub parent: String,
    pub sequence: u64,
    pub route: Route,
    pub kind: OperationKind,
    pub state: ExecutionState,
    pub outcome: ExecutionOutcome,
    pub request: String,
    pub runtime: String,
    pub receipt: String,
    pub worker_generation: String,
    pub protocol_generation: u64,
    pub lease_generation: u64,
}
#[derive(Clone, Debug)]
pub struct Collector {
    pub count: u64,
    pub unresolved: u64,
    /// Host-bound original digest. Rust checks its form, not the external original.
    pub digest: String,
}
#[derive(Clone, Debug)]
pub struct EvidenceSnapshot {
    pub issuer: String,
    pub task: String,
    pub revision: u64,
    pub worker_generation: String,
    pub protocol_generation: u64,
    pub lease_generation: u64,
    pub scope: String,
    pub collector: Collector,
    pub executions: BTreeMap<String, Execution>,
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
fn nonnegative(x: &Expr) -> Result<u64, Error> {
    let n = integer(x)?;
    if n < 0 {
        return Err(bad("expected nonnegative integer"));
    }
    Ok(n as u64)
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
fn references(x: &Expr) -> Result<Vec<String>, Error> {
    let xs = sequence(x)?;
    if xs.len() > 512 {
        return Err(Error::new(
            ErrorKind::ResourceLimit,
            "execution reference count limit",
        ));
    }
    let mut unique = BTreeSet::new();
    let mut result = Vec::new();
    for x in xs {
        let id = text(x)?;
        if !unique.insert(id.clone()) {
            return Err(bad("duplicate execution reference"));
        }
        result.push(id);
    }
    Ok(result)
}
fn executions(x: &Expr, scope: &str) -> Result<BTreeMap<String, Execution>, Error> {
    let input = sequence(x)?;
    if input.len() > 512 {
        return Err(Error::new(ErrorKind::ResourceLimit, "execution count limit"));
    }
    let mut result = BTreeMap::new();
    let mut sequences = BTreeSet::new();
    for item in input {
        let xs = sequence(item)?;
        if !matches!(xs.first(), Some(Expr::Symbol(s)) if s == "execution") {
            return Err(bad("expected execution declaration"));
        }
        let e = fields(
            &xs[1..],
            &[
                "id", "scope", "parent", "sequence", "route", "kind", "state", "outcome",
                "request", "runtime", "receipt", "worker-generation", "protocol-generation",
                "lease-generation",
            ],
        )?;
        let id = text(e["id"])?;
        let execution_scope = text(e["scope"])?;
        if execution_scope != scope {
            return Err(bad("execution scope differs from authoritative snapshot"));
        }
        let sequence = positive(e["sequence"])?;
        if sequence > input.len() as u64 || !sequences.insert(sequence) {
            return Err(bad("execution sequence is duplicate or incomplete"));
        }
        let route = match keyword(e["route"])?.as_str() {
            "owned" => Route::Owned,
            "native" => Route::Native,
            _ => return Err(bad("unknown execution route")),
        };
        let kind = match keyword(e["kind"])?.as_str() {
            "process" => OperationKind::Process,
            "file" => OperationKind::File,
            _ => return Err(bad("unknown execution kind")),
        };
        let state = match keyword(e["state"])?.as_str() {
            "completed" => ExecutionState::Completed,
            "denied" => ExecutionState::Denied,
            "unknown" => ExecutionState::Unknown,
            "prepared" => ExecutionState::Prepared,
            "dispatching" => ExecutionState::Dispatching,
            "running" => ExecutionState::Running,
            "cancelled-before-dispatch" => ExecutionState::CancelledBeforeDispatch,
            "cancelled-confirmed" => ExecutionState::CancelledConfirmed,
            _ => return Err(bad("unknown execution state")),
        };
        let outcome = match keyword(e["outcome"])?.as_str() {
            "succeeded" => ExecutionOutcome::Succeeded,
            "failed" => ExecutionOutcome::Failed,
            "none" => ExecutionOutcome::None,
            _ => return Err(bad("unknown execution outcome")),
        };
        if (state == ExecutionState::Completed) == (outcome == ExecutionOutcome::None) {
            return Err(bad("execution state conflicts with outcome"));
        }
        let execution = Execution {
            id: id.clone(),
            scope: execution_scope,
            parent: text(e["parent"])?,
            sequence,
            route,
            kind,
            state,
            outcome,
            request: digest(e["request"])?,
            runtime: digest(e["runtime"])?,
            receipt: digest(e["receipt"])?,
            worker_generation: text(e["worker-generation"])?,
            protocol_generation: positive(e["protocol-generation"])?,
            lease_generation: positive(e["lease-generation"])?,
        };
        if result.insert(id, execution).is_some() {
            return Err(bad("duplicate execution id"));
        }
    }
    Ok(result)
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
                "worker-generation",
                "protocol-generation",
                "lease-generation",
                "scope",
                "collector",
                "executions",
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
        if integer(f["schema"])? != 2 || text(f["authority"])? != "kiokuko-dsh" {
            return Err(bad("unsupported evidence schema/authority"));
        }
        let issuer = text(f["issuer"])?;
        if issuer != "kiokuko-dsh:owned-execution:v1" {
            return Err(bad("unsupported evidence issuer"));
        }
        let task = text(f["task"])?;
        let revision = positive(f["revision"])?;
        let worker_generation = text(f["worker-generation"])?;
        let protocol_generation = positive(f["protocol-generation"])?;
        let lease_generation = positive(f["lease-generation"])?;
        let scope = text(f["scope"])?;
        let c = fields(
            sequence(f["collector"])?,
            &["version", "complete", "count", "unresolved", "digest"],
        )?;
        if integer(c["version"])? != 1 || !matches!(c["complete"], Expr::Symbol(s) if s == "t") {
            return Err(bad("unsupported or incomplete execution collector"));
        }
        let collector = Collector {
            count: nonnegative(c["count"])?,
            unresolved: nonnegative(c["unresolved"])?,
            digest: digest(c["digest"])?,
        };
        let executions = executions(f["executions"], &scope)?;
        let unresolved = executions.values().filter(|e| e.state.unresolved()).count() as u64;
        if collector.count != executions.len() as u64 || collector.unresolved != unresolved {
            return Err(bad("collector count differs from execution snapshot"));
        }
        // Unresolved operations remain available in the authority's audit journal,
        // but must not be used to issue a successful protocol decision.
        if collector.unresolved != 0 {
            return Err(bad("execution snapshot has unresolved operations"));
        }
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
                    "worker-generation",
                    "protocol-generation",
                    "lease-generation",
                    "source",
                    "tests",
                    "command",
                    "runtime",
                    "outcome",
                    "exit",
                    "assertions",
                    "status",
                    "provenance",
                    "supporting",
                    "history",
                    "state-digest",
                ],
            )?;
            let id = text(a["id"])?;
            let artifact_digest = digest(a["digest"])?;
            if text(a["worker-generation"])? != worker_generation
                || positive(a["protocol-generation"])? != protocol_generation
                || positive(a["lease-generation"])? != lease_generation
            {
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
            let provenance = match keyword(a["provenance"])?.as_str() {
                "execution-backed" => Provenance::ExecutionBacked,
                "state-derived" => Provenance::StateDerived,
                "pure-evaluation" => Provenance::PureEvaluation,
                _ => return Err(bad("unknown artifact provenance")),
            };
            let supporting = references(a["supporting"])?;
            let history = references(a["history"])?;
            let state_digest = digest(a["state-digest"])?;
            for reference in supporting.iter().chain(history.iter()) {
                if !executions.contains_key(reference) {
                    return Err(bad("unresolved artifact execution reference"));
                }
            }
            // Binding names are protocol-defined; a differently named artifact
            // must not turn native exit status into proof for passes-p/fails-p.
            let test_evidence = name == "test-spec"
                || matches!(outcome, Outcome::Passed | Outcome::AssertionFailure);
            if test_evidence && provenance != Provenance::ExecutionBacked {
                return Err(bad("test evidence requires execution-backed provenance"));
            }
            match provenance {
                Provenance::ExecutionBacked => {
                    if supporting.is_empty() {
                        return Err(bad("execution-backed artifact requires supporting executions"));
                    }
                    for reference in &supporting {
                        let e = &executions[reference];
                        if e.worker_generation != worker_generation
                            || e.protocol_generation != protocol_generation
                            || e.lease_generation != lease_generation
                            || e.runtime != input_digests["runtime"]
                            || e.state != ExecutionState::Completed
                        {
                            return Err(bad("supporting execution is not current completed evidence"));
                        }
                        if test_evidence
                            && (e.route != Route::Owned || e.kind != OperationKind::Process)
                        {
                            return Err(bad("test evidence requires an owned process execution"));
                        }
                        let expected = match outcome {
                            Outcome::Passed | Outcome::Produced => Some(ExecutionOutcome::Succeeded),
                            Outcome::AssertionFailure
                            | Outcome::SyntaxError
                            | Outcome::Timeout
                            | Outcome::SetupError
                            | Outcome::Signaled => Some(ExecutionOutcome::Failed),
                            Outcome::Skipped | Outcome::NotRun => None,
                        };
                        if expected.is_some_and(|expected| e.outcome != expected) {
                            return Err(bad("artifact outcome conflicts with supporting execution"));
                        }
                    }
                }
                Provenance::StateDerived => {
                    if !supporting.is_empty()
                        || state_digest != input_digests["source"]
                        || outcome != Outcome::Produced
                    {
                        return Err(bad("state-derived artifact requires current source state without execution support"));
                    }
                }
                Provenance::PureEvaluation => {
                    if !supporting.is_empty()
                        || collector.count != 0
                        || outcome != Outcome::Produced
                    {
                        return Err(bad("pure evaluation requires a complete zero-execution snapshot"));
                    }
                }
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
                    worker_generation: worker_generation.clone(),
                    protocol_generation,
                    lease_generation,
                    provenance,
                    supporting,
                    history,
                    state_digest,
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
            worker_generation,
            protocol_generation,
            lease_generation,
            scope,
            collector,
            executions,
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
            worker_generation: String::new(),
            protocol_generation: 0,
            lease_generation: 0,
            scope: String::new(),
            collector: Collector {
                count: 0,
                unresolved: 0,
                digest: String::new(),
            },
            executions: BTreeMap::new(),
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
