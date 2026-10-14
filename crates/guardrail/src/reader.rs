#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Expr {
    Int(i64),
    Str(String),
    Symbol(String),
    Keyword(String),
    Nil,
    List(Vec<Expr>),
    Quote(Box<Expr>),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    Syntax,
    UnsupportedForm,
    Arity,
    Unbound,
    Type,
    ResourceLimit,
    Host,
    Protocol,
    Violation,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error {
    pub kind: ErrorKind,
    pub message: String,
    pub offset: Option<usize>,
}
impl Error {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            offset: None,
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}
impl std::error::Error for Error {}
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub input_bytes: usize,
    pub depth: usize,
    pub nodes: usize,
    pub steps: usize,
    pub value_nodes: usize,
    pub host_calls: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            input_bytes: 262144,
            depth: 64,
            nodes: 16384,
            steps: 100000,
            value_nodes: 16384,
            host_calls: 1024,
        }
    }
}
impl Limits {
    /// Callers can lower budgets, never disable the engine's hard ceilings.
    pub fn bounded(self) -> Self {
        Self {
            input_bytes: self.input_bytes.min(1_048_576),
            depth: self.depth.min(128),
            nodes: self.nodes.min(65_536),
            steps: self.steps.min(1_000_000),
            value_nodes: self.value_nodes.min(65_536),
            host_calls: self.host_calls.min(4_096),
        }
    }
}
pub fn read(input: &str, limits: Limits) -> Result<Vec<Expr>, Error> {
    let limits = limits.bounded();
    if input.len() > limits.input_bytes {
        return Err(Error::new(ErrorKind::ResourceLimit, "input byte limit"));
    }
    let mut p = Reader {
        input,
        position: 0,
        nodes: 0,
        limits,
    };
    let mut forms = Vec::new();
    p.space();
    while p.position < input.len() {
        forms.push(p.expr(0)?);
        p.space();
    }
    Ok(forms)
}
struct Reader<'a> {
    input: &'a str,
    position: usize,
    nodes: usize,
    limits: Limits,
}
impl Reader<'_> {
    fn error(&self, kind: ErrorKind, message: &str) -> Error {
        Error {
            kind,
            message: message.into(),
            offset: Some(self.position),
        }
    }
    fn peek(&self) -> Option<char> {
        self.input[self.position..].chars().next()
    }
    fn take(&mut self) -> Option<char> {
        let c = self.peek()?;
        self.position += c.len_utf8();
        Some(c)
    }
    fn space(&mut self) {
        loop {
            match self.peek() {
                Some(c) if c.is_ascii_whitespace() => {
                    self.take();
                }
                Some(';') => while !matches!(self.take(), None | Some('\n')) {},
                _ => break,
            }
        }
    }
    fn expr(&mut self, depth: usize) -> Result<Expr, Error> {
        self.space();
        if depth > self.limits.depth || self.nodes >= self.limits.nodes {
            return Err(self.error(ErrorKind::ResourceLimit, "reader depth/node limit"));
        }
        self.nodes += 1;
        match self.take() {
            None => Err(self.error(ErrorKind::Syntax, "expected expression")),
            Some(')') => Err(self.error(ErrorKind::Syntax, "unexpected closing parenthesis")),
            Some('(') => {
                let mut list = Vec::new();
                loop {
                    self.space();
                    match self.peek() {
                        Some(')') => {
                            self.take();
                            break;
                        }
                        None => return Err(self.error(ErrorKind::Syntax, "unclosed list")),
                        _ => list.push(self.expr(depth + 1)?),
                    }
                }
                Ok(if list.is_empty() {
                    Expr::Nil
                } else {
                    Expr::List(list)
                })
            }
            Some('\'') => Ok(Expr::Quote(Box::new(self.expr(depth + 1)?))),
            Some('"') => {
                let mut value = String::new();
                loop {
                    match self.take() {
                        Some('"') => break,
                        Some('\\') => value.push(match self.take() {
                            Some('n') => '\n',
                            Some('r') => '\r',
                            Some('t') => '\t',
                            Some('"') => '"',
                            Some('\\') => '\\',
                            _ => {
                                return Err(self.error(
                                    ErrorKind::Syntax,
                                    "invalid or unterminated string escape",
                                ))
                            }
                        }),
                        Some(c) if c != '\0' => value.push(c),
                        _ => {
                            return Err(self.error(ErrorKind::Syntax, "unterminated string or NUL"))
                        }
                    }
                }
                Ok(Expr::Str(value))
            }
            Some(first) => {
                let start = self.position - first.len_utf8();
                while let Some(c) = self.peek() {
                    if c.is_ascii_whitespace() || matches!(c, '(' | ')' | ';' | '\'' | '"') {
                        break;
                    }
                    self.take();
                }
                let token = &self.input[start..self.position];
                let numeric = first.is_ascii_digit()
                    || ((first == '-' || first == '+')
                        && token.as_bytes().get(1).is_some_and(u8::is_ascii_digit));
                if numeric {
                    return token.parse::<i64>().map(Expr::Int).map_err(|_| {
                        self.error(ErrorKind::Syntax, "invalid or out-of-range integer")
                    });
                }
                let (keyword, name) = if let Some(name) = token.strip_prefix(':') {
                    (true, name)
                } else {
                    (false, token)
                };
                if name.is_empty()
                    || name == "."
                    || !name
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"-+*/<>=!?_.$%&~^".contains(&c))
                {
                    return Err(
                        self.error(ErrorKind::Syntax, "unsupported symbol or reader syntax")
                    );
                }
                let name = name.to_ascii_lowercase();
                Ok(if keyword {
                    Expr::Keyword(name)
                } else if name == "nil" {
                    Expr::Nil
                } else {
                    Expr::Symbol(name)
                })
            }
        }
    }
}
