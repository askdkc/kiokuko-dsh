use crate::eval::{Env, HostQuery, Value};
use crate::{Error, ErrorKind, Expr, Limits};
use std::collections::BTreeMap;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Phase {
    pub name: String,
    pub requires: Vec<String>,
    pub produces: Vec<String>,
    pub guard: Option<Expr>,
    pub next: String,
    pub on_violation: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Protocol {
    pub name: String,
    pub phases: Vec<Phase>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Artifact {
    pub value: Value,
    pub digest: String,
    pub producer: String,
    pub entry: u64,
    pub generation: u64,
    pub dependencies: BTreeMap<String, u64>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunState {
    pub protocol_digest: String,
    pub phase: String,
    pub entry: u64,
    pub generation: u64,
    pub artifacts: BTreeMap<String, Artifact>,
    pub done: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Output {
    pub name: String,
    pub value: Value,
    pub digest: String,
    pub entry: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    Advanced,
    Rejected,
    Done,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transition {
    pub state: RunState,
    pub decision: Decision,
}
use crate::digest::sha256;
use crate::eval::{eval, render, truthy, validate};
use std::collections::BTreeSet;
fn error(message: impl Into<String>) -> Error {
    Error::new(ErrorKind::Protocol, message)
}
fn violation(message: impl Into<String>) -> Error {
    Error::new(ErrorKind::Violation, message)
}
fn symbol(expr: &Expr) -> Result<String, Error> {
    match expr {
        Expr::Symbol(s) if s != "t" => Ok(s.clone()),
        _ => Err(error("expected nonconstant symbol")),
    }
}
fn list(expr: &Expr) -> Result<&[Expr], Error> {
    match expr {
        Expr::List(xs) => Ok(xs),
        _ => Err(error("expected nonempty declaration list")),
    }
}
fn names(xs: &[Expr]) -> Result<Vec<String>, Error> {
    if xs.is_empty() || xs.len() > 128 {
        return Err(error("requires/produces need 1..128 artifact names"));
    }
    let mut seen = BTreeSet::new();
    xs.iter()
        .map(|x| {
            let name = symbol(x)?;
            if !seen.insert(name.clone()) {
                return Err(error("duplicate artifact name"));
            }
            Ok(name)
        })
        .collect()
}
fn guard_bindings(expr: &Expr, names: &mut BTreeSet<String>) {
    match expr {
        Expr::Symbol(s) if s != "t" => {
            names.insert(s.clone());
        }
        Expr::Quote(_) => {}
        Expr::List(xs) if !xs.is_empty() => {
            if matches!(&xs[0], Expr::Symbol(s) if s == "quote") {
                return;
            }
            for arg in &xs[1..] {
                guard_bindings(arg, names);
            }
        }
        _ => {}
    }
}
pub fn compile(forms: &[Expr], host: &dyn HostQuery, limits: Limits) -> Result<Protocol, Error> {
    let limits = limits.bounded();
    if forms.len() != 1 {
        return Err(error("exactly one defprotocol is required"));
    }
    let xs = list(&forms[0])?;
    if xs.len() < 3
        || xs.len() > 130
        || xs.len() > limits.nodes
        || !matches!(&xs[0], Expr::Symbol(s) if s == "defprotocol")
    {
        return Err(error("expected defprotocol with 1..128 phases"));
    }
    let name = symbol(&xs[1])?;
    let mut phases = Vec::new();
    let mut phase_names = BTreeSet::new();
    let mut produced = BTreeSet::new();
    for declaration in &xs[2..] {
        let ys = list(declaration)?;
        if ys.len() < 4 || !matches!(&ys[0], Expr::Keyword(s) if s == "phase") {
            return Err(error("phase must begin with :phase NAME"));
        }
        let name = symbol(&ys[1])?;
        if !phase_names.insert(name.clone()) {
            return Err(error("duplicate phase"));
        }
        let mut phase = Phase {
            name,
            requires: vec![],
            produces: vec![],
            guard: None,
            next: String::new(),
            on_violation: None,
        };
        let mut fields = BTreeSet::new();
        let mut i = 2;
        while i < ys.len() {
            let field = match &ys[i] {
                Expr::Keyword(s) => s.as_str(),
                _ => return Err(error("expected phase property keyword")),
            };
            if !fields.insert(field) {
                return Err(error(format!("duplicate property :{field}")));
            }
            i += 1;
            if i >= ys.len() {
                return Err(error("property has no value"));
            }
            match field {
                "requires" | "produces" => {
                    let begin = i;
                    while i < ys.len() && !matches!(&ys[i], Expr::Keyword(_)) {
                        i += 1;
                    }
                    let ns = names(&ys[begin..i])?;
                    if field == "requires" {
                        phase.requires = ns;
                    } else {
                        phase.produces = ns;
                    }
                }
                "guard" => {
                    validate(&ys[i], host, limits)?;
                    phase.guard = Some(ys[i].clone());
                    i += 1;
                }
                "next" => {
                    phase.next = if matches!(&ys[i],Expr::Keyword(s) if s == "done") {
                        ":done".into()
                    } else {
                        symbol(&ys[i])?
                    };
                    i += 1;
                }
                "on-violation" => {
                    phase.on_violation = Some(symbol(&ys[i])?);
                    i += 1;
                }
                _ => return Err(error(format!("unknown phase property :{field}"))),
            }
        }
        if let Some(guard) = &phase.guard {
            let mut bindings = BTreeSet::new();
            guard_bindings(guard, &mut bindings);
            if bindings.iter().any(|name| !phase.requires.contains(name)) {
                return Err(error(
                    "every guard artifact reference must be declared in :requires",
                ));
            }
        }
        if phase.next.is_empty() {
            return Err(error("every phase needs :next"));
        }
        for output in &phase.produces {
            if !produced.insert(output.clone()) {
                return Err(error("each artifact needs exactly one producer phase"));
            }
        }
        if phase.produces.iter().any(|s| phase.requires.contains(s)) {
            return Err(error("a phase cannot require its own output"));
        }
        phases.push(phase);
    }
    for phase in &phases {
        if phase.next != ":done" && !phase_names.contains(&phase.next) {
            return Err(error("unknown :next phase"));
        }
        if phase
            .on_violation
            .as_ref()
            .is_some_and(|n| !phase_names.contains(n))
        {
            return Err(error("unknown :on-violation phase"));
        }
        if phase.requires.iter().any(|n| !produced.contains(n)) {
            return Err(error("required artifact has no declared producer"));
        }
    }
    Ok(Protocol { name, phases })
}
fn canonical_expr(e: &Expr) -> String {
    match e {
        Expr::Int(n) => n.to_string(),
        Expr::Str(s) => render(&Value::Str(s.clone())),
        Expr::Symbol(s) => s.clone(),
        Expr::Keyword(s) => format!(":{s}"),
        Expr::Nil => "nil".into(),
        Expr::List(xs) => {
            if xs.is_empty() {
                "nil".into()
            } else {
                format!(
                    "({})",
                    xs.iter().map(canonical_expr).collect::<Vec<_>>().join(" ")
                )
            }
        }
        Expr::Quote(x) => format!("(quote {})", canonical_expr(x)),
    }
}
/// Versioned canonical encoding independent of whitespace and reader letter case.
pub fn fingerprint(protocol: &Protocol) -> String {
    let mut data = String::from("kiokuko-protocol-v1\n");
    fn field(out: &mut String, s: &str) {
        out.push_str(&format!("{}:{s}\n", s.len()));
    }
    field(&mut data, &protocol.name);
    for p in &protocol.phases {
        field(&mut data, &p.name);
        field(&mut data, &p.requires.join(" "));
        field(&mut data, &p.produces.join(" "));
        field(
            &mut data,
            &p.guard.as_ref().map(canonical_expr).unwrap_or_default(),
        );
        field(&mut data, &p.next);
        field(&mut data, p.on_violation.as_deref().unwrap_or(""));
    }
    sha256(data.as_bytes())
}
fn phase<'a>(protocol: &'a Protocol, name: &str) -> Result<&'a Phase, Error> {
    protocol
        .phases
        .iter()
        .find(|p| p.name == name)
        .ok_or_else(|| violation("unknown current phase"))
}
pub fn start(protocol: &Protocol) -> Result<RunState, Error> {
    let first = protocol
        .phases
        .first()
        .ok_or_else(|| error("empty protocol"))?;
    Ok(RunState {
        protocol_digest: fingerprint(protocol),
        phase: first.name.clone(),
        entry: 1,
        generation: 0,
        artifacts: BTreeMap::new(),
        done: false,
    })
}
pub fn check_phase(
    protocol: &Protocol,
    name: &str,
    env: &Env,
    host: &dyn HostQuery,
    limits: Limits,
) -> Result<bool, Error> {
    let p = phase(protocol, name)?;
    for name in &p.requires {
        if !env.contains_key(name) {
            return Err(violation(format!("required artifact missing: {name}")));
        }
    }
    match &p.guard {
        Some(guard) => Ok(truthy(&eval(guard, env, host, limits)?)),
        None => Ok(true),
    }
}
fn enter(protocol: &Protocol, state: &mut RunState, next: &str) -> Result<(), Error> {
    state.entry = state
        .entry
        .checked_add(1)
        .ok_or_else(|| Error::new(ErrorKind::ResourceLimit, "phase entry overflow"))?;
    if next == ":done" {
        state.done = true;
        state.phase = ":done".into();
        return Ok(());
    }
    let target = phase(protocol, next)?;
    let mut invalid: BTreeSet<String> = target.produces.iter().cloned().collect();
    loop {
        let old_len = invalid.len();
        for (name, a) in &state.artifacts {
            if a.dependencies.keys().any(|dep| invalid.contains(dep)) {
                invalid.insert(name.clone());
            }
        }
        if invalid.len() == old_len {
            break;
        }
    }
    state.artifacts.retain(|name, _| !invalid.contains(name));
    state.phase = next.into();
    Ok(())
}
fn state_valid(protocol: &Protocol, state: &RunState) -> Result<(), Error> {
    if state.done || state.protocol_digest != fingerprint(protocol) || state.entry == 0 {
        return Err(violation("completed state or protocol binding mismatch"));
    }
    phase(protocol, &state.phase)?;
    for (name, a) in &state.artifacts {
        let owner = protocol
            .phases
            .iter()
            .find(|p| p.produces.contains(name))
            .ok_or_else(|| violation("unknown artifact in state"))?;
        if owner.name != a.producer
            || a.entry >= state.entry
            || a.generation == 0
            || a.generation > state.generation
        {
            return Err(violation("invalid artifact provenance"));
        }
        if owner.requires.len() != a.dependencies.len()
            || owner
                .requires
                .iter()
                .any(|n| !a.dependencies.contains_key(n))
        {
            return Err(violation("artifact dependency binding mismatch"));
        }
        for (dep, generation) in &a.dependencies {
            if state
                .artifacts
                .get(dep)
                .is_none_or(|d| d.generation != *generation)
            {
                return Err(violation("stale artifact dependency"));
            }
        }
    }
    Ok(())
}
pub fn advance(
    protocol: &Protocol,
    state: &RunState,
    outputs: &[Output],
    host: &dyn HostQuery,
    limits: Limits,
) -> Result<Transition, Error> {
    state_valid(protocol, state)?;
    let p = phase(protocol, &state.phase)?;
    let env: Env = state
        .artifacts
        .iter()
        .map(|(name, a)| (name.clone(), a.value.clone()))
        .collect();
    for name in &p.requires {
        if !env.contains_key(name) {
            return Err(violation(format!("required artifact missing: {name}")));
        }
    }
    if outputs.len() != p.produces.len() {
        return Err(violation("all and only declared outputs are required"));
    }
    let mut seen = BTreeSet::new();
    for o in outputs {
        if o.entry != state.entry || !p.produces.contains(&o.name) || !seen.insert(&o.name) {
            return Err(violation(
                "wrong output name, duplicate, or stale phase-entry token",
            ));
        }
        if o.digest.len() != 64
            || !o
                .digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(violation("output digest must be lowercase SHA-256"));
        }
    }
    if !check_phase(protocol, &state.phase, &env, host, limits)? {
        let mut rejected = state.clone();
        if let Some(next) = &p.on_violation {
            enter(protocol, &mut rejected, next)?;
        }
        return Ok(Transition {
            state: rejected,
            decision: Decision::Rejected,
        });
    }
    let mut next = state.clone();
    let dependencies: BTreeMap<String, u64> = p
        .requires
        .iter()
        .map(|n| (n.clone(), state.artifacts[n].generation))
        .collect();
    for o in outputs {
        // Normalize and bound values through the same pure evaluator boundary.
        let mut binding = Env::new();
        binding.insert("output-value".into(), o.value.clone());
        let value = eval(&Expr::Symbol("output-value".into()), &binding, host, limits)?;
        next.generation = next
            .generation
            .checked_add(1)
            .ok_or_else(|| Error::new(ErrorKind::ResourceLimit, "artifact generation overflow"))?;
        next.artifacts.insert(
            o.name.clone(),
            Artifact {
                value,
                digest: o.digest.clone(),
                producer: p.name.clone(),
                entry: state.entry,
                generation: next.generation,
                dependencies: dependencies.clone(),
            },
        );
    }
    enter(protocol, &mut next, &p.next)?;
    let decision = if next.done {
        Decision::Done
    } else {
        Decision::Advanced
    };
    Ok(Transition {
        state: next,
        decision,
    })
}
