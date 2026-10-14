use crate::{Error, ErrorKind, Expr, Limits};
use std::collections::BTreeMap;
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    Int(i64),
    Str(String),
    Symbol(String),
    Keyword(String),
    Nil,
    Bool(bool),
    List(Vec<Value>),
    Host(HostValue),
}
/// Opaque to the evaluator; only trusted host adapters may interpret it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostValue {
    pub id: String,
}
pub type Env = BTreeMap<String, Value>;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuerySpec {
    pub name: String,
    pub min_args: usize,
    pub max_args: usize,
}
pub trait HostQuery {
    fn queries(&self) -> Vec<QuerySpec>;
    fn call(&self, name: &str, args: &[Value]) -> Result<Value, Error>;
}
pub struct NoHost;
impl HostQuery for NoHost {
    fn queries(&self) -> Vec<QuerySpec> {
        vec![]
    }
    fn call(&self, name: &str, _: &[Value]) -> Result<Value, Error> {
        Err(Error::new(ErrorKind::UnsupportedForm, name))
    }
}
fn fail(kind: ErrorKind, message: impl Into<String>) -> Error {
    Error::new(kind, message)
}
fn yes(b: bool) -> Value {
    if b {
        Value::Symbol("t".into())
    } else {
        Value::Nil
    }
}
pub fn truthy(v: &Value) -> bool {
    !matches!(v, Value::Nil | Value::Bool(false)) && !matches!(v, Value::List(xs) if xs.is_empty())
}
fn builtin(name: &str) -> Option<(usize, usize)> {
    match name {
        "and" | "or" | "list" => Some((0, 65_536)),
        "when" | "unless" => Some((1, 65_536)),
        "if" => Some((3, 3)),
        "not" | "null" | "quote" | "car" | "cdr" => Some((1, 1)),
        "=" | "<" | ">" | "<=" | ">=" | "eq" | "equal" | "cons" => Some((2, 2)),
        _ => None,
    }
}
fn forbidden(name: &str) -> bool {
    matches!(
        name,
        "defun"
            | "defmacro"
            | "lambda"
            | "setq"
            | "setf"
            | "let"
            | "let*"
            | "loop"
            | "dolist"
            | "dotimes"
            | "eval"
            | "read"
            | "load"
            | "format"
            | "print"
            | "write"
            | "open"
            | "close"
            | "delete-file"
            | "rename-file"
            | "compile"
            | "apply"
            | "funcall"
    )
}
fn valid_keyword(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name == name.to_ascii_lowercase()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-+*/<>=!?_.$%&~^".contains(&b))
}
fn valid_symbol(name: &str) -> bool {
    if !valid_keyword(name) || name == "nil" {
        return false;
    }
    matches!(crate::read(name, Limits::default()).as_deref(), Ok([Expr::Symbol(s)]) if s == name)
}
fn schema(host: &dyn HostQuery) -> Result<BTreeMap<String, (usize, usize)>, Error> {
    let specs = host.queries();
    if specs.len() > 64 {
        return Err(fail(ErrorKind::ResourceLimit, "host query schema limit"));
    }
    let mut map = BTreeMap::new();
    for q in specs {
        if !valid_symbol(&q.name)
            || forbidden(&q.name)
            || builtin(&q.name).is_some()
            || q.min_args > q.max_args
            || q.max_args > 128
            || map.contains_key(&q.name)
        {
            return Err(fail(
                ErrorKind::UnsupportedForm,
                format!("invalid host query schema: {}", q.name),
            ));
        }
        map.insert(q.name, (q.min_args, q.max_args));
    }
    Ok(map)
}
struct Validator<'a> {
    limits: Limits,
    nodes: usize,
    bytes: usize,
    schema: &'a BTreeMap<String, (usize, usize)>,
}
impl Validator<'_> {
    fn visit(&mut self, expr: &Expr, depth: usize, data: bool) -> Result<(), Error> {
        if depth > self.limits.depth || self.nodes >= self.limits.nodes {
            return Err(fail(
                ErrorKind::ResourceLimit,
                "expression depth/node limit",
            ));
        }
        self.nodes += 1;
        if let Expr::Str(s) | Expr::Symbol(s) | Expr::Keyword(s) = expr {
            self.bytes = self
                .bytes
                .checked_add(s.len())
                .ok_or_else(|| fail(ErrorKind::ResourceLimit, "expression byte overflow"))?;
            if self.bytes > self.limits.input_bytes {
                return Err(fail(
                    ErrorKind::ResourceLimit,
                    "aggregate expression byte limit",
                ));
            }
        }
        match expr {
            Expr::Str(s) | Expr::Symbol(s) | Expr::Keyword(s)
                if s.len() > self.limits.input_bytes =>
            {
                return Err(fail(ErrorKind::ResourceLimit, "atom byte limit"))
            }
            Expr::Quote(e) => self.visit(e, depth + 1, true)?,
            Expr::List(items) if !items.is_empty() && !data => {
                let name = match &items[0] {
                    Expr::Symbol(s) => s,
                    _ => {
                        return Err(fail(
                            ErrorKind::UnsupportedForm,
                            "operator must be a literal symbol",
                        ))
                    }
                };
                let (min, max) = builtin(name)
                    .or_else(|| self.schema.get(name).copied())
                    .ok_or_else(|| fail(ErrorKind::UnsupportedForm, name))?;
                if forbidden(name) {
                    return Err(fail(ErrorKind::UnsupportedForm, name));
                }
                let count = items.len() - 1;
                if count < min || count > max {
                    return Err(fail(
                        ErrorKind::Arity,
                        format!("{name}: expected {min}..{max}, got {count}"),
                    ));
                }
                for e in &items[1..] {
                    self.visit(e, depth + 1, name == "quote")?;
                }
            }
            Expr::List(items) => {
                for e in items {
                    self.visit(e, depth + 1, data)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
}
pub fn validate(expr: &Expr, host: &dyn HostQuery, limits: Limits) -> Result<(), Error> {
    let queries = schema(host)?;
    Validator {
        limits: limits.bounded(),
        nodes: 0,
        bytes: 0,
        schema: &queries,
    }
    .visit(expr, 0, false)
}
pub fn eval(expr: &Expr, env: &Env, host: &dyn HostQuery, limits: Limits) -> Result<Value, Error> {
    let limits = limits.bounded();
    validate(expr, host, limits)?;
    let mut engine = Evaluator {
        limits,
        steps: 0,
        bytes: 0,
        host_calls: 0,
        env,
        host,
    };
    engine.value(expr, 0)
}
struct Evaluator<'a> {
    limits: Limits,
    steps: usize,
    bytes: usize,
    host_calls: usize,
    env: &'a Env,
    host: &'a dyn HostQuery,
}
impl Evaluator<'_> {
    fn tick(&mut self) -> Result<(), Error> {
        if self.steps >= self.limits.steps {
            return Err(fail(ErrorKind::ResourceLimit, "evaluation step limit"));
        }
        self.steps += 1;
        Ok(())
    }
    fn normalized(&mut self, value: &Value) -> Result<Value, Error> {
        self.normalize_at(value, 0, &mut 0)
    }
    fn normalize_at(
        &mut self,
        value: &Value,
        depth: usize,
        count: &mut usize,
    ) -> Result<Value, Error> {
        self.tick()?;
        if depth > self.limits.depth || *count >= self.limits.value_nodes {
            return Err(fail(ErrorKind::ResourceLimit, "value depth/node limit"));
        }
        *count += 1;
        let bytes = match value {
            Value::Str(s) | Value::Symbol(s) | Value::Keyword(s) => s.len(),
            Value::Host(h) => h.id.len(),
            _ => 0,
        };
        self.bytes = self
            .bytes
            .checked_add(bytes)
            .ok_or_else(|| fail(ErrorKind::ResourceLimit, "value byte overflow"))?;
        if self.bytes > self.limits.input_bytes {
            return Err(fail(
                ErrorKind::ResourceLimit,
                "cumulative normalized value byte limit",
            ));
        }
        Ok(match value {
            Value::Bool(b) => yes(*b),
            Value::List(xs) if xs.is_empty() => Value::Nil,
            Value::List(xs) => Value::List(
                xs.iter()
                    .map(|x| self.normalize_at(x, depth + 1, count))
                    .collect::<Result<_, _>>()?,
            ),
            Value::Str(s) | Value::Symbol(s) | Value::Keyword(s)
                if s.len() > self.limits.input_bytes =>
            {
                return Err(fail(ErrorKind::ResourceLimit, "host atom byte limit"))
            }
            Value::Symbol(s) => {
                let s = s.to_ascii_lowercase();
                if s != "nil" && !valid_symbol(&s) {
                    return Err(fail(ErrorKind::Host, "invalid host symbol"));
                }
                if s == "nil" {
                    Value::Nil
                } else {
                    Value::Symbol(s)
                }
            }
            Value::Keyword(s) => {
                let s = s.to_ascii_lowercase();
                if !valid_keyword(&s) {
                    return Err(fail(ErrorKind::Host, "invalid host keyword"));
                }
                Value::Keyword(s)
            }
            Value::Host(h) if h.id.len() > self.limits.input_bytes => {
                return Err(fail(ErrorKind::ResourceLimit, "opaque handle byte limit"))
            }
            v => v.clone(),
        })
    }
    fn quoted(&mut self, expr: &Expr, depth: usize) -> Result<Value, Error> {
        self.tick()?;
        if depth > self.limits.depth {
            return Err(fail(ErrorKind::ResourceLimit, "quoted data depth limit"));
        }
        Ok(match expr {
            Expr::Int(n) => Value::Int(*n),
            Expr::Str(s) => Value::Str(s.clone()),
            Expr::Symbol(s) => Value::Symbol(s.clone()),
            Expr::Keyword(s) => Value::Keyword(s.clone()),
            Expr::Nil => Value::Nil,
            Expr::List(xs) if xs.is_empty() => Value::Nil,
            Expr::List(xs) => Value::List(
                xs.iter()
                    .map(|x| self.quoted(x, depth + 1))
                    .collect::<Result<_, _>>()?,
            ),
            Expr::Quote(e) => Value::List(vec![
                Value::Symbol("quote".into()),
                self.quoted(e, depth + 1)?,
            ]),
        })
    }
    fn value(&mut self, expr: &Expr, depth: usize) -> Result<Value, Error> {
        self.tick()?;
        if depth > self.limits.depth {
            return Err(fail(ErrorKind::ResourceLimit, "evaluation depth limit"));
        }
        let value = match expr {
            Expr::Int(n) => Value::Int(*n),
            Expr::Str(s) => Value::Str(s.clone()),
            Expr::Keyword(s) => Value::Keyword(s.clone()),
            Expr::Nil => Value::Nil,
            Expr::Symbol(s) if s == "t" => yes(true),
            Expr::Symbol(s) => {
                let v = self.env.get(s).ok_or_else(|| fail(ErrorKind::Unbound, s))?;
                return self.normalized(v);
            }
            Expr::Quote(e) => self.quoted(e, depth + 1)?,
            Expr::List(xs) if xs.is_empty() => Value::Nil,
            Expr::List(xs) => {
                let name = match &xs[0] {
                    Expr::Symbol(s) => s.as_str(),
                    _ => unreachable!("validated operator"),
                };
                let args = &xs[1..];
                match name {
                    "quote" => self.quoted(&args[0], depth + 1)?,
                    "and" => {
                        let mut value = yes(true);
                        for arg in args {
                            value = self.value(arg, depth + 1)?;
                            if !truthy(&value) {
                                break;
                            }
                        }
                        value
                    }
                    "or" => {
                        let mut value = Value::Nil;
                        for arg in args {
                            value = self.value(arg, depth + 1)?;
                            if truthy(&value) {
                                break;
                            }
                        }
                        value
                    }
                    "if" => {
                        let condition = self.value(&args[0], depth + 1)?;
                        self.value(&args[if truthy(&condition) { 1 } else { 2 }], depth + 1)?
                    }
                    "when" | "unless" => {
                        let condition = truthy(&self.value(&args[0], depth + 1)?);
                        let mut value = Value::Nil;
                        if condition == (name == "when") {
                            for arg in &args[1..] {
                                value = self.value(arg, depth + 1)?;
                            }
                        }
                        value
                    }
                    _ => {
                        let values = args
                            .iter()
                            .map(|x| self.value(x, depth + 1))
                            .collect::<Result<Vec<_>, _>>()?;
                        self.apply(name, &values)?
                    }
                }
            }
        };
        self.normalized(&value)
    }
    fn apply(&mut self, name: &str, args: &[Value]) -> Result<Value, Error> {
        Ok(match name {
            "not" | "null" => yes(!truthy(&args[0])),
            "=" | "<" | ">" | "<=" | ">=" => {
                let (a, b) = match (&args[0], &args[1]) {
                    (Value::Int(a), Value::Int(b)) => (*a, *b),
                    _ => {
                        return Err(fail(
                            ErrorKind::Type,
                            "numeric comparison requires integers",
                        ))
                    }
                };
                yes(match name {
                    "=" => a == b,
                    "<" => a < b,
                    ">" => a > b,
                    "<=" => a <= b,
                    _ => a >= b,
                })
            }
            "eq" => yes(!matches!(
                (&args[0], &args[1]),
                (Value::List(_), _) | (_, Value::List(_))
            ) && args[0] == args[1]),
            "equal" => yes(args[0] == args[1]),
            "list" => Value::List(args.to_vec()),
            "car" => match &args[0] {
                Value::Nil => Value::Nil,
                Value::List(xs) => xs.first().cloned().unwrap_or(Value::Nil),
                _ => return Err(fail(ErrorKind::Type, "car requires proper list")),
            },
            "cdr" => match &args[0] {
                Value::Nil => Value::Nil,
                Value::List(xs) => Value::List(xs.get(1..).unwrap_or(&[]).to_vec()),
                _ => return Err(fail(ErrorKind::Type, "cdr requires proper list")),
            },
            "cons" => {
                let mut values = vec![args[0].clone()];
                match &args[1] {
                    Value::Nil => {}
                    Value::List(xs) => values.extend_from_slice(xs),
                    _ => return Err(fail(ErrorKind::Type, "cons tail must be a proper list")),
                };
                Value::List(values)
            }
            _ => {
                if self.host_calls >= self.limits.host_calls {
                    return Err(fail(ErrorKind::ResourceLimit, "host call limit"));
                }
                self.host_calls += 1;
                self.host.call(name, args)?
            }
        })
    }
}
fn string_literal(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
/// Stable serialization for bounded values returned by this evaluator.
pub fn render(value: &Value) -> String {
    match value {
        Value::Nil | Value::Bool(false) => "nil".into(),
        Value::Bool(true) => "t".into(),
        Value::Int(n) => n.to_string(),
        Value::Str(s) => string_literal(s),
        Value::Symbol(s) => s.clone(),
        Value::Keyword(s) => format!(":{s}"),
        Value::List(xs) if xs.is_empty() => "nil".into(),
        Value::List(xs) => format!("({})", xs.iter().map(render).collect::<Vec<_>>().join(" ")),
        Value::Host(h) => format!("(host {})", string_literal(&h.id)),
    }
}
