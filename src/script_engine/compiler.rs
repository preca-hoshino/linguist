//! TypeScript annotation stripping, module export transformation, and compile-time
//! extraction/merging of `tags`, `meta`, and exported lifecycle hooks.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Monotonic ID generator for compiled script units.
static NEXT_COMPILE_ID: AtomicU64 = AtomicU64::new(1);

use anyhow::{Context as AnyhowContext, Result, anyhow, bail};
use boa_engine::context::HostHooks;
use boa_engine::job::IdleJobQueue;
use boa_engine::realm::Realm;
use boa_engine::{Context, JsNativeError, JsResult, JsString, Source, js_string};
use serde_json::{Map, Value};

use crate::models::{CompiledScriptChain, CompiledScriptUnit, ScriptItem};

/// Sandboxed host hooks blocking dynamic `eval`/`Function` compilation and capping buffer sizes.
#[derive(Debug, Clone, Copy)]
pub(super) struct LinguistHostHooks {
    /// Maximum allowed `ArrayBuffer` size in bytes.
    pub max_buffer_bytes: u64,
}

/// Returns a static `LinguistHostHooks` reference for the configured memory limit without leaking per call.
pub(super) fn host_hooks_for_mb(memory_limit_mb: u64) -> &'static LinguistHostHooks {
    static CACHE: OnceLock<Mutex<HashMap<u64, &'static LinguistHostHooks>>> = OnceLock::new();
    static FALLBACK: LinguistHostHooks = LinguistHostHooks {
        max_buffer_bytes: 32 * 1024 * 1024,
    };
    let clamped = memory_limit_mb.clamp(1, 512);
    let map = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut guard) = map.lock() {
        if let Some(existing) = guard.get(&clamped) {
            return existing;
        }
        let leaked: &'static LinguistHostHooks = Box::leak(Box::new(LinguistHostHooks {
            max_buffer_bytes: clamped.saturating_mul(1024 * 1024),
        }));
        guard.insert(clamped, leaked);
        return leaked;
    }
    &FALLBACK
}

impl HostHooks for LinguistHostHooks {
    fn ensure_can_compile_strings(
        &self,
        _realm: Realm,
        _parameters: &[JsString],
        _body: &JsString,
        _direct: bool,
        _context: &mut Context,
    ) -> JsResult<()> {
        Err(JsNativeError::typ()
            .with_message("dynamic eval/Function compilation is disabled in Linguist sandbox")
            .into())
    }

    fn max_buffer_size(&self, _context: &mut Context) -> u64 {
        self.max_buffer_bytes
    }
}

/// Offline compile-time result for a single `ScriptItem`.
#[derive(Debug, Clone)]
struct ExtractedUnit {
    /// Declared `tags`.
    tags: Vec<String>,
    /// Declared `meta`.
    meta: Map<String, Value>,
    /// Executable JS factory source.
    js_code: String,
    /// Whether `onRequest` is exported.
    has_on_request: bool,
    /// Whether `onBilling` is exported.
    has_on_billing: bool,
}

/// Compiles and validates an ordered chain of `ScriptItem`s offline (without network access),
/// merging `tags` (deduplicated union) and `meta` (shallow merge, later overwrites earlier)
/// across all enabled scripts.
///
/// # Errors
/// Returns an error if any enabled script has invalid syntax, throws during top-level
/// declaration evaluation, or exports non-array `tags` / non-object `meta`.
pub fn compile_script_chain(
    scripts: &[ScriptItem],
    cpu_timeout_ms: u64,
    memory_limit_mb: u64,
) -> Result<CompiledScriptChain> {
    let mut chain = CompiledScriptChain::default();
    let mut seen_tags = HashSet::new();
    let mut has_req = false;
    let mut has_bill = false;

    for (idx, item) in scripts.iter().enumerate() {
        if !item.enabled {
            continue;
        }
        let unit = compile_single_script(&item.code, cpu_timeout_ms, memory_limit_mb)
            .with_context(|| {
                format!(
                    "script #{} ('{}' / '{}') failed compilation",
                    idx + 1,
                    item.name,
                    item.id
                )
            })?;

        for tag in unit.tags {
            if seen_tags.insert(tag.clone()) {
                chain.tags.push(tag);
            }
        }
        for (k, v) in unit.meta {
            chain.meta.insert(k, v);
        }
        if unit.has_on_request {
            has_req = true;
        }
        if unit.has_on_billing {
            has_bill = true;
        }
        if unit.has_on_request || unit.has_on_billing {
            chain.units.push(CompiledScriptUnit {
                compile_id: NEXT_COMPILE_ID.fetch_add(1, Ordering::Relaxed),
                id: item.id.clone(),
                name: item.name.clone(),
                js_code: unit.js_code,
                has_on_request: unit.has_on_request,
                has_on_billing: unit.has_on_billing,
            });
        }
    }

    if has_req {
        chain.hooks.push("onRequest".to_string());
    }
    if has_bill {
        chain.hooks.push("onBilling".to_string());
    }
    Ok(chain)
}

/// Compiles one script source, evaluates top-level declarations in an isolated offline VM,
/// and extracts `tags`, `meta`, and exported hook flags.
fn compile_single_script(
    source: &str,
    cpu_timeout_ms: u64,
    memory_limit_mb: u64,
) -> Result<ExtractedUnit> {
    let js_factory = prepare_module_factory_js(source);
    let mut boa = boa_engine::context::ContextBuilder::new()
        .host_hooks(host_hooks_for_mb(memory_limit_mb))
        .job_queue(Rc::new(IdleJobQueue))
        .build()
        .map_err(|err| anyhow!("failed to initialize compile-time Boa VM: {err}"))?;

    let limits = boa.runtime_limits_mut();
    limits.set_loop_iteration_limit(50_000);
    limits.set_recursion_limit(256);
    limits.set_stack_size_limit(8_192);

    let probe = format!(
        "{js_factory}\n\
         const __m = __linguist_module();\n\
         JSON.stringify({{\n\
           tags: __m.tags === undefined ? null : __m.tags,\n\
           meta: __m.meta === undefined ? null : __m.meta,\n\
           hasOnRequest: typeof __m.onRequest === 'function',\n\
           hasOnBilling: typeof __m.onBilling === 'function'\n\
         }});"
    );

    let started = Instant::now();
    let timeout = Duration::from_millis(cpu_timeout_ms.max(1));

    let script = boa_engine::Script::parse(Source::from_bytes(probe.as_bytes()), None, &mut boa)
        .map_err(|err| anyhow!("script syntax error: {err}"))?;

    let res = script
        .evaluate(&mut boa)
        .map_err(|err| anyhow!("script top-level evaluation error: {err}"))?;

    if started.elapsed() > timeout {
        bail!(
            "compile-time declaration evaluation exceeded {}ms",
            timeout.as_millis()
        );
    }

    let json_str = res
        .as_string()
        .map(boa_engine::JsString::to_std_string_escaped)
        .ok_or_else(|| anyhow!("compile probe did not return JSON string"))?;
    let parsed: Value =
        serde_json::from_str(&json_str).context("failed to parse compile probe JSON")?;

    let tags = match parsed.get("tags") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(arr)) => {
            let mut out = Vec::with_capacity(arr.len());
            for item in arr {
                let Some(s) = item.as_str() else {
                    bail!("exported `tags` must contain only strings");
                };
                out.push(s.to_string());
            }
            out
        }
        Some(_) => bail!("exported `tags` must be an array of strings"),
    };

    let meta = match parsed.get("meta") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(map)) => map.clone(),
        Some(_) => bail!("exported `meta` must be a plain object"),
    };

    let has_on_request = parsed
        .get("hasOnRequest")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let has_on_billing = parsed
        .get("hasOnBilling")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let _ = js_string!("");

    Ok(ExtractedUnit {
        tags,
        meta,
        js_code: js_factory,
        has_on_request,
        has_on_billing,
    })
}

/// Strips TypeScript annotations and transforms ES module `export` statements (or legacy
/// inline statements) into a `function __linguist_module()` factory returning
/// `{ tags, meta, onRequest, onBilling }`.
#[must_use]
pub fn prepare_module_factory_js(source: &str) -> String {
    let stripped = strip_typescript_annotations(source);
    let tokens = tokenize(&stripped);
    let (body, exports) = rewrite_exports(&tokens);

    if exports.is_empty() {
        let trimmed = body.trim();
        if trimmed.is_empty() {
            return "function __linguist_module() { return {}; }".to_string();
        }
        return format!(
            "function __linguist_module() {{\n\
               async function __linguist_inline(ctx) {{\n{body}\n}}\n\
               return {{ onRequest: __linguist_inline }};\n\
             }}"
        );
    }

    let mut ret_entries = Vec::with_capacity(exports.len());
    for (export_name, local_name) in exports {
        if export_name == "default" {
            ret_entries.push(format!("onRequest: {local_name}"));
        } else {
            ret_entries.push(format!("{export_name}: {local_name}"));
        }
    }

    format!(
        "function __linguist_module() {{\n{body}\n  return {{ {} }};\n}}",
        ret_entries.join(", ")
    )
}

/// Rewrites top-level `export` declarations into ordinary local bindings and returns
/// `(rewritten_body, vec_of_(export_name, local_expr))`.
fn rewrite_exports(tokens: &[Token]) -> (String, Vec<(String, String)>) {
    let mut out = String::with_capacity(tokens.len() * 4);
    let mut exports: Vec<(String, String)> = Vec::new();
    let mut i = 0usize;
    let mut brace_depth = 0usize;
    let mut paren_depth = 0usize;
    let mut bracket_depth = 0usize;

    while i < tokens.len() {
        let tok = &tokens[i];
        let at_top = brace_depth == 0 && paren_depth == 0 && bracket_depth == 0;

        if at_top
            && tok.kind == TokKind::Ident
            && tok.text == "export"
            && is_stmt_start(tokens, i)
            && let Some((next_idx, emitted, mut found)) = try_rewrite_export_stmt(tokens, i)
        {
            out.push_str(&emitted);
            exports.append(&mut found);
            i = next_idx;
            continue;
        }

        if !matches!(
            tok.kind,
            TokKind::Whitespace | TokKind::Comment | TokKind::String | TokKind::Template
        ) {
            match tok.text.as_str() {
                "{" => brace_depth += 1,
                "}" => brace_depth = brace_depth.saturating_sub(1),
                "(" => paren_depth += 1,
                ")" => paren_depth = paren_depth.saturating_sub(1),
                "[" => bracket_depth += 1,
                "]" => bracket_depth = bracket_depth.saturating_sub(1),
                _ => {}
            }
        }
        out.push_str(&tok.text);
        i += 1;
    }

    (out, exports)
}

/// Attempts to rewrite one top-level `export ...` construct starting at token `export_idx`.
/// Result of rewriting one `export` statement: `(next_token_idx, js_code, exported_names)`.
type ExportRewrite = (usize, String, Vec<(String, String)>);

/// Attempts to rewrite one `export` statement starting at `export_idx`.
fn try_rewrite_export_stmt(tokens: &[Token], export_idx: usize) -> Option<ExportRewrite> {
    let mut cursor = next_non_ws_idx(tokens, export_idx)?;
    let first = &tokens[cursor];

    if first.kind == TokKind::Ident && first.text == "default" {
        let after_def = next_non_ws_idx(tokens, cursor)?;
        return Some((
            after_def,
            "const __linguist_default = ".to_string(),
            vec![("default".to_string(), "__linguist_default".to_string())],
        ));
    }

    if first.kind == TokKind::Ident && first.text == "async" {
        let fn_idx = next_non_ws_idx(tokens, cursor)?;
        if tokens[fn_idx].kind == TokKind::Ident && tokens[fn_idx].text == "function" {
            let name_idx = next_non_ws_idx(tokens, fn_idx)?;
            if tokens[name_idx].kind == TokKind::Ident {
                let name = tokens[name_idx].text.clone();
                return Some((cursor, String::new(), vec![(name.clone(), name)]));
            }
        }
        return None;
    }

    if first.kind == TokKind::Ident && first.text == "function" {
        let name_idx = next_non_ws_idx(tokens, cursor)?;
        if tokens[name_idx].kind == TokKind::Ident {
            let name = tokens[name_idx].text.clone();
            return Some((cursor, String::new(), vec![(name.clone(), name)]));
        }
        return None;
    }

    if first.kind == TokKind::Ident && matches!(first.text.as_str(), "const" | "let" | "var") {
        let name_idx = next_non_ws_idx(tokens, cursor)?;
        if tokens[name_idx].kind == TokKind::Ident {
            let name = tokens[name_idx].text.clone();
            return Some((cursor, String::new(), vec![(name.clone(), name)]));
        }
        return None;
    }

    if first.text == "{" {
        cursor += 1;
        let mut inner = Vec::new();
        while cursor < tokens.len() && tokens[cursor].text != "}" {
            if tokens[cursor].kind == TokKind::Ident {
                let local = tokens[cursor].text.clone();
                if next_non_ws_text(tokens, cursor) == Some("as")
                    && let Some(as_idx) = next_non_ws_idx(tokens, cursor)
                    && let Some(alias_idx) = next_non_ws_idx(tokens, as_idx)
                    && tokens[alias_idx].kind == TokKind::Ident
                {
                    inner.push((tokens[alias_idx].text.clone(), local));
                    cursor = alias_idx + 1;
                    continue;
                }
                inner.push((local.clone(), local));
            }
            cursor += 1;
        }
        if cursor < tokens.len() && tokens[cursor].text == "}" {
            cursor += 1;
            if let Some(semi) = next_non_ws_idx(tokens, cursor - 1)
                && tokens[semi].text == ";"
            {
                cursor = semi + 1;
            }
        }
        return Some((cursor, String::new(), inner));
    }

    None
}

/// Mutable parser state tracked while stripping TypeScript annotations.
struct StripState {
    /// Emitted JavaScript code.
    out: String,
    /// Current token index.
    idx: usize,
    /// Open parenthesis classification stack.
    paren_stack: Vec<ParenKind>,
    /// Current ternary `?` depth inside the active statement.
    ternary_depth: usize,
}

/// Lexer-aware TypeScript annotation stripper that preserves string literals,
/// template literals, and comments untouched while stripping:
/// - `interface Foo { ... }` and `type Foo = ...;` declarations
/// - `import type ...;` lines
/// - variable `: Type` annotations (`const x: number = 1`)
/// - parameter `: Type` / `?: Type` annotations (`(ctx: ScriptContext)`)
/// - return `: Type` annotations (`): ScriptContext | void {` or `): number =>`)
/// - `as Type` and `satisfies Type` assertions
#[must_use]
pub fn strip_typescript_annotations(input: &str) -> String {
    let tokens = tokenize(input);
    let mut state = StripState {
        out: String::with_capacity(input.len()),
        idx: 0,
        paren_stack: Vec::new(),
        ternary_depth: 0,
    };

    while state.idx < tokens.len() {
        let tok = &tokens[state.idx];

        if matches!(
            tok.kind,
            TokKind::Whitespace | TokKind::Comment | TokKind::String | TokKind::Template
        ) {
            state.out.push_str(&tok.text);
            state.idx += 1;
            continue;
        }

        if let Some(next_idx) = try_strip_top_level_ts_decl(&tokens, state.idx) {
            state.idx = next_idx;
            continue;
        }

        if tok.kind == TokKind::Ident
            && matches!(tok.text.as_str(), "as" | "satisfies")
            && is_as_assertion_context(&tokens, state.idx)
        {
            state.idx = skip_type_expr(&tokens, state.idx + 1, TypeStop::AsExpr);
            continue;
        }

        step_punctuation_or_emit(&tokens, &mut state);
    }

    state.out
}

/// Attempts to skip `interface`, `type`, `import type`, or `export interface/type` declarations.
fn try_strip_top_level_ts_decl(tokens: &[Token], i: usize) -> Option<usize> {
    let tok = &tokens[i];
    if tok.kind != TokKind::Ident || !is_stmt_start(tokens, i) {
        return None;
    }
    if tok.text == "interface" {
        return Some(skip_interface_decl(tokens, i));
    }
    if tok.text == "type" && next_non_ws_is_ident(tokens, i) {
        return Some(skip_type_alias(tokens, i));
    }
    if tok.text == "import" && next_non_ws_text(tokens, i) == Some("type") {
        return Some(skip_until_semi_or_newline(tokens, i));
    }
    if tok.text == "export"
        && let Some(ni) = next_non_ws_idx(tokens, i)
        && tokens[ni].kind == TokKind::Ident
    {
        if tokens[ni].text == "interface" {
            return Some(skip_interface_decl(tokens, ni));
        }
        if tokens[ni].text == "type" && next_non_ws_is_ident(tokens, ni) {
            return Some(skip_type_alias(tokens, ni));
        }
    }
    None
}

/// Processes punctuation tokens (`?`, `(`, `)`, `:`, `;`, `<`) or emits the token text unchanged.
fn step_punctuation_or_emit(tokens: &[Token], state: &mut StripState) {
    let i = state.idx;
    let tok = &tokens[i];

    if tok.kind == TokKind::Punct && tok.text == "?" {
        if matches!(state.paren_stack.last(), Some(ParenKind::FnParams))
            && next_non_ws_text(tokens, i) == Some(":")
            && let Some(colon_idx) = next_non_ws_idx(tokens, i)
        {
            state.idx = skip_type_expr(tokens, colon_idx + 1, TypeStop::Param);
            return;
        }
        state.ternary_depth = state.ternary_depth.saturating_add(1);
    } else if tok.kind == TokKind::Punct && tok.text == "<" {
        if let Some(after_generics) = try_skip_call_generics(tokens, i) {
            state.idx = after_generics;
            return;
        }
    } else if tok.kind == TokKind::Punct && tok.text == "(" {
        let kind = if is_fn_param_open(tokens, i) {
            ParenKind::FnParams
        } else {
            ParenKind::Expr
        };
        state.paren_stack.push(kind);
    } else if tok.kind == TokKind::Punct && tok.text == ")" {
        let popped = state.paren_stack.pop();
        state.out.push_str(&tok.text);
        state.idx += 1;
        if (matches!(popped, Some(ParenKind::FnParams))
            || looks_like_arrow_return(tokens, state.idx))
            && let Some(colon_idx) = next_non_ws_idx(tokens, state.idx - 1)
            && tokens[colon_idx].text == ":"
        {
            state.idx = skip_type_expr(tokens, colon_idx + 1, TypeStop::ReturnType);
        }
        return;
    } else if tok.kind == TokKind::Punct && tok.text == ":" {
        if matches!(state.paren_stack.last(), Some(ParenKind::FnParams)) {
            state.idx = skip_type_expr(tokens, i + 1, TypeStop::Param);
            return;
        }
        if state.ternary_depth > 0 {
            state.ternary_depth = state.ternary_depth.saturating_sub(1);
        } else if is_var_type_annotation(tokens, i) {
            state.idx = skip_type_expr(tokens, i + 1, TypeStop::VarDecl);
            return;
        }
    } else if tok.kind == TokKind::Punct && tok.text == ";" {
        state.ternary_depth = 0;
    }

    state.out.push_str(&tok.text);
    state.idx += 1;
}

/// Strips explicit type arguments on generic calls like `fetchJson<{ ttl?: number }>(...)`.
fn try_skip_call_generics(tokens: &[Token], open_angle: usize) -> Option<usize> {
    let prev = prev_non_ws_idx(tokens, open_angle)?;
    if tokens[prev].kind != TokKind::Ident {
        return None;
    }
    let mut depth = 0usize;
    let mut i = open_angle;
    while i < tokens.len() {
        let t = &tokens[i];
        if t.kind == TokKind::String || t.kind == TokKind::Template {
            return None;
        }
        match t.text.as_str() {
            "<" => depth += 1,
            ">" => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    if next_non_ws_text(tokens, i) == Some("(") {
                        return Some(i + 1);
                    }
                    return None;
                }
            }
            ";" => return None,
            _ => {}
        }
        i += 1;
    }
    None
}

/// Parenthesis classification for TS parameter list tracking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ParenKind {
    /// Parameter list of a function or arrow function.
    FnParams,
    /// Ordinary grouping or call parenthesis.
    Expr,
}

/// Boundary mode when skipping a TypeScript type expression.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TypeStop {
    /// Stop before `,`, `)`, `=` (at depth 0).
    Param,
    /// Stop before `=>` or `{` (at depth 0).
    ReturnType,
    /// Stop before `=` or `;` or newline (at depth 0).
    VarDecl,
    /// Stop before delimiter/operator after `as <Type>`.
    AsExpr,
}

/// Lexer token category.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TokKind {
    /// Identifier or keyword.
    Ident,
    /// Numeric literal.
    Number,
    /// Single or multi-char punctuation / operator.
    Punct,
    /// Single/double-quoted string literal.
    String,
    /// Template literal `` `...` ``.
    Template,
    /// Whitespace or newline.
    Whitespace,
    /// `//` or `/* ... */` comment.
    Comment,
}

/// Single token produced by the lightweight JS/TS lexer.
#[derive(Debug, Clone)]
struct Token {
    /// Category.
    kind: TokKind,
    /// Raw source slice.
    text: String,
}

/// Tokenizes JS/TS source while keeping strings, template literals, and comments intact.
fn tokenize(input: &str) -> Vec<Token> {
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut tokens = Vec::new();
    let mut i = 0usize;

    while i < len {
        let ch = bytes[i];
        if ch.is_ascii_whitespace() {
            let start = i;
            while i < len && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            tokens.push(Token {
                kind: TokKind::Whitespace,
                text: input[start..i].to_string(),
            });
        } else if ch == b'/' && i + 1 < len && (bytes[i + 1] == b'/' || bytes[i + 1] == b'*') {
            let (end, tok) = scan_comment_token(input, i);
            i = end;
            tokens.push(tok);
        } else if ch == b'\'' || ch == b'"' {
            let (end, tok) = scan_quoted_string(input, i, ch);
            i = end;
            tokens.push(tok);
        } else if ch == b'`' {
            let (end, tok) = scan_template_literal(input, i);
            i = end;
            tokens.push(tok);
        } else if ch.is_ascii_alphabetic() || ch == b'_' || ch == b'$' || ch >= 0x80 {
            let start = i;
            while i < len {
                let c = input[i..].chars().next().unwrap_or('\0');
                if c.is_alphanumeric() || c == '_' || c == '$' {
                    i += c.len_utf8();
                } else {
                    break;
                }
            }
            tokens.push(Token {
                kind: TokKind::Ident,
                text: input[start..i].to_string(),
            });
        } else if ch.is_ascii_digit() {
            let start = i;
            while i < len
                && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'.' || bytes[i] == b'_')
            {
                i += 1;
            }
            tokens.push(Token {
                kind: TokKind::Number,
                text: input[start..i].to_string(),
            });
        } else {
            let (end, tok) = scan_punct_token(input, i);
            i = end;
            tokens.push(tok);
        }
    }

    tokens
}

/// Scans a `//` line comment or `/* ... */` block comment starting at `start`.
fn scan_comment_token(input: &str, start: usize) -> (usize, Token) {
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut i = start + 2;
    if bytes[start + 1] == b'/' {
        while i < len && bytes[i] != b'\n' {
            i += 1;
        }
    } else {
        while i + 1 < len && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
            i += 1;
        }
        i = (i + 2).min(len);
    }
    (
        i,
        Token {
            kind: TokKind::Comment,
            text: input[start..i].to_string(),
        },
    )
}

/// Scans a single or double-quoted string literal starting at `start`.
fn scan_quoted_string(input: &str, start: usize, quote: u8) -> (usize, Token) {
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut i = start + 1;
    while i < len {
        if bytes[i] == b'\\' && i + 1 < len {
            i += 2;
            continue;
        }
        if bytes[i] == quote {
            i += 1;
            break;
        }
        i += 1;
    }
    (
        i,
        Token {
            kind: TokKind::String,
            text: input[start..i].to_string(),
        },
    )
}

/// Scans a template literal `` `...${...}...` `` starting at `start`.
fn scan_template_literal(input: &str, start: usize) -> (usize, Token) {
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut i = start + 1;
    let mut interp_depth = 0usize;
    while i < len {
        if bytes[i] == b'\\' && i + 1 < len {
            i += 2;
            continue;
        }
        if bytes[i] == b'$' && i + 1 < len && bytes[i + 1] == b'{' {
            interp_depth += 1;
            i += 2;
            continue;
        }
        if interp_depth > 0 {
            if bytes[i] == b'{' {
                interp_depth += 1;
            } else if bytes[i] == b'}' {
                interp_depth -= 1;
            }
            i += 1;
            continue;
        }
        if bytes[i] == b'`' {
            i += 1;
            break;
        }
        i += 1;
    }
    (
        i,
        Token {
            kind: TokKind::Template,
            text: input[start..i].to_string(),
        },
    )
}

/// Scans multi-character or single-character punctuation at `start`.
fn scan_punct_token(input: &str, start: usize) -> (usize, Token) {
    let rest = &input[start..];
    let multi = [
        "===", "!==", "??=", "=>", "?.", "??", "&&", "||", "==", "!=",
    ]
    .into_iter()
    .find(|op| rest.starts_with(op));
    if let Some(op) = multi {
        return (
            start + op.len(),
            Token {
                kind: TokKind::Punct,
                text: op.to_string(),
            },
        );
    }
    let ch_char = rest.chars().next().unwrap_or(' ');
    (
        start + ch_char.len_utf8(),
        Token {
            kind: TokKind::Punct,
            text: ch_char.to_string(),
        },
    )
}

/// Returns the index of the next non-whitespace/non-comment token after `idx`.
fn next_non_ws_idx(tokens: &[Token], mut idx: usize) -> Option<usize> {
    idx += 1;
    while idx < tokens.len() {
        if !matches!(tokens[idx].kind, TokKind::Whitespace | TokKind::Comment) {
            return Some(idx);
        }
        idx += 1;
    }
    None
}

/// Returns the text of the next non-whitespace/non-comment token after `idx`.
fn next_non_ws_text(tokens: &[Token], idx: usize) -> Option<&str> {
    next_non_ws_idx(tokens, idx).map(|i| tokens[i].text.as_str())
}

/// Returns true if the next non-whitespace token is an identifier.
fn next_non_ws_is_ident(tokens: &[Token], idx: usize) -> bool {
    next_non_ws_idx(tokens, idx).is_some_and(|i| tokens[i].kind == TokKind::Ident)
}

/// Returns the index of the previous non-whitespace/non-comment token before `idx`.
fn prev_non_ws_idx(tokens: &[Token], idx: usize) -> Option<usize> {
    let mut cur = idx;
    while cur > 0 {
        cur -= 1;
        if !matches!(tokens[cur].kind, TokKind::Whitespace | TokKind::Comment) {
            return Some(cur);
        }
    }
    None
}

/// Checks whether token `idx` starts a statement (preceded by start, `;`, `{`, `}`, or newline).
fn is_stmt_start(tokens: &[Token], idx: usize) -> bool {
    let Some(prev) = prev_non_ws_idx(tokens, idx) else {
        return true;
    };
    if matches!(tokens[prev].text.as_str(), ";" | "{" | "}") {
        return true;
    }
    tokens[prev + 1..idx]
        .iter()
        .any(|t| t.kind == TokKind::Whitespace && t.text.contains('\n'))
}

/// Skips an `interface Foo { ... }` declaration.
fn skip_interface_decl(tokens: &[Token], mut idx: usize) -> usize {
    let mut depth = 0usize;
    let mut seen_brace = false;
    while idx < tokens.len() {
        if tokens[idx].text == "{" {
            depth += 1;
            seen_brace = true;
        } else if tokens[idx].text == "}" {
            depth = depth.saturating_sub(1);
            if seen_brace && depth == 0 {
                return idx + 1;
            }
        }
        idx += 1;
    }
    idx
}

/// Skips a `type Foo = ...;` declaration.
fn skip_type_alias(tokens: &[Token], mut idx: usize) -> usize {
    let mut depth = 0usize;
    while idx < tokens.len() {
        match tokens[idx].text.as_str() {
            "{" | "(" | "[" | "<" => depth += 1,
            "}" | ")" | "]" | ">" => depth = depth.saturating_sub(1),
            ";" if depth == 0 => return idx + 1,
            _ => {}
        }
        idx += 1;
    }
    idx
}

/// Skips an `import type ...` statement until `;` or newline.
fn skip_until_semi_or_newline(tokens: &[Token], mut idx: usize) -> usize {
    while idx < tokens.len() {
        if tokens[idx].text == ";" {
            return idx + 1;
        }
        if tokens[idx].kind == TokKind::Whitespace && tokens[idx].text.contains('\n') {
            return idx + 1;
        }
        idx += 1;
    }
    idx
}

/// Checks whether `(` at `idx` opens a function/arrow parameter list.
fn is_fn_param_open(tokens: &[Token], idx: usize) -> bool {
    if let Some(prev) = prev_non_ws_idx(tokens, idx) {
        if tokens[prev].text == "function" {
            return true;
        }
        if tokens[prev].kind == TokKind::Ident
            && let Some(prev2) = prev_non_ws_idx(tokens, prev)
            && tokens[prev2].text == "function"
        {
            return true;
        }
    }
    looks_like_arrow_params(tokens, idx)
}

/// Scans forward from `(` to check if the matching `)` is followed by `=>` or `: <Type> =>`.
fn looks_like_arrow_params(tokens: &[Token], open_idx: usize) -> bool {
    let mut depth = 0usize;
    let mut i = open_idx;
    while i < tokens.len() {
        if tokens[i].text == "(" {
            depth += 1;
        } else if tokens[i].text == ")" {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return looks_like_arrow_return(tokens, i + 1);
            }
        }
        i += 1;
    }
    false
}

/// Returns true if tokens starting at `after_paren` match `=>` or `: <Type> =>`.
fn looks_like_arrow_return(tokens: &[Token], after_paren: usize) -> bool {
    let Some(first) = next_non_ws_idx(tokens, after_paren.saturating_sub(1)) else {
        return false;
    };
    if tokens[first].text == "=>" {
        return true;
    }
    if tokens[first].text == ":" {
        let stop_idx = skip_type_expr(tokens, first + 1, TypeStop::ReturnType);
        return stop_idx < tokens.len() && tokens[stop_idx].text == "=>";
    }
    false
}

/// Checks if `:` at `colon_idx` belongs to a `const/let/var ident: Type` declaration.
fn is_var_type_annotation(tokens: &[Token], colon_idx: usize) -> bool {
    let Some(ident_idx) = prev_non_ws_idx(tokens, colon_idx) else {
        return false;
    };
    if tokens[ident_idx].kind != TokKind::Ident {
        return false;
    }
    let Some(kw_idx) = prev_non_ws_idx(tokens, ident_idx) else {
        return false;
    };
    matches!(tokens[kw_idx].text.as_str(), "const" | "let" | "var")
}

/// Checks if `as`/`satisfies` at `idx` is a TypeScript assertion.
fn is_as_assertion_context(tokens: &[Token], idx: usize) -> bool {
    let Some(prev) = prev_non_ws_idx(tokens, idx) else {
        return false;
    };
    if !(tokens[prev].kind == TokKind::Ident
        || tokens[prev].kind == TokKind::Number
        || tokens[prev].kind == TokKind::String
        || tokens[prev].kind == TokKind::Template
        || matches!(tokens[prev].text.as_str(), ")" | "]" | "}"))
    {
        return false;
    }
    if tokens[prev].text == "*" {
        return false;
    }
    if let Some(prev2) = prev_non_ws_idx(tokens, prev)
        && matches!(tokens[prev2].text.as_str(), "{" | ",")
    {
        let mut scan = prev2;
        while scan > 0 {
            if tokens[scan].text == "import" {
                return false;
            }
            if matches!(tokens[scan].text.as_str(), ";" | "}") {
                break;
            }
            scan -= 1;
        }
    }
    next_non_ws_idx(tokens, idx).is_some()
}

/// Advances past a TypeScript type expression until the requested stop boundary at depth 0.
fn skip_type_expr(tokens: &[Token], mut idx: usize, stop: TypeStop) -> usize {
    let mut brace_depth = 0usize;
    let mut paren_depth = 0usize;
    let mut bracket_depth = 0usize;
    let mut angle_depth = 0usize;
    let mut seen_type_token = false;

    while idx < tokens.len() {
        let tok = &tokens[idx];
        let at_top = brace_depth == 0 && paren_depth == 0 && bracket_depth == 0 && angle_depth == 0;

        if at_top {
            match stop {
                TypeStop::Param => {
                    if matches!(tok.text.as_str(), "," | ")" | "=") {
                        return idx;
                    }
                }
                TypeStop::ReturnType => {
                    if matches!(tok.text.as_str(), "=>" | "{") {
                        return idx;
                    }
                }
                TypeStop::VarDecl => {
                    if matches!(tok.text.as_str(), "=" | ";") {
                        return idx;
                    }
                    if tok.kind == TokKind::Whitespace && tok.text.contains('\n') {
                        return idx;
                    }
                }
                TypeStop::AsExpr => {
                    if seen_type_token
                        && matches!(
                            tok.text.as_str(),
                            ";" | ","
                                | ")"
                                | "]"
                                | "}"
                                | "."
                                | "?."
                                | "??"
                                | "&&"
                                | "||"
                                | "==="
                                | "!=="
                                | "=="
                                | "!="
                                | "+"
                                | "-"
                                | "*"
                                | "/"
                                | ":"
                                | "?"
                        )
                    {
                        return idx;
                    }
                    if seen_type_token && tok.kind == TokKind::Whitespace && tok.text.contains('\n')
                    {
                        return idx;
                    }
                }
            }
        }

        match tok.text.as_str() {
            "{" => brace_depth += 1,
            "}" => {
                if brace_depth == 0 {
                    return idx;
                }
                brace_depth -= 1;
            }
            "(" => paren_depth += 1,
            ")" => {
                if paren_depth == 0 {
                    return idx;
                }
                paren_depth -= 1;
            }
            "[" => bracket_depth += 1,
            "]" => {
                if bracket_depth == 0 {
                    return idx;
                }
                bracket_depth -= 1;
            }
            "<" => angle_depth += 1,
            ">" => {
                angle_depth = angle_depth.saturating_sub(1);
            }
            _ => {}
        }

        if !(matches!(tok.kind, TokKind::Whitespace | TokKind::Comment)
            || stop == TypeStop::AsExpr && matches!(tok.text.as_str(), "as" | "satisfies"))
        {
            seen_type_token = true;
        }

        idx += 1;
    }

    idx
}
