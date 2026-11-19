//! TypeScript/JavaScript script transpiler and sandboxed Boa execution engine.

pub mod pipeline;

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context as AnyhowContext, Result, anyhow};
use boa_engine::context::HostHooks;
use boa_engine::realm::Realm;
use boa_engine::{Context, JsNativeError, JsResult, JsString, JsValue, Source, js_string};

use crate::config::ScriptEngineConfig;
use crate::models::ScriptContext;

/// Sandboxed host hooks blocking dynamic `eval`/`Function` compilation and capping buffer sizes.
#[derive(Debug, Clone, Copy)]
struct LinguistHostHooks {
    /// Maximum allowed `ArrayBuffer` size in bytes.
    max_buffer_bytes: u64,
}

/// Static default hooks instance used when memory limit matches default (32 MiB).
static DEFAULT_SANDBOX_HOOKS: LinguistHostHooks = LinguistHostHooks {
    max_buffer_bytes: 32 * 1024 * 1024,
};

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

/// Pure-Rust TypeScript-to-JavaScript execution engine backed by `boa_engine`.
#[derive(Debug, Clone)]
pub struct ScriptEngine {
    /// Runtime sandbox configuration.
    config: Arc<ScriptEngineConfig>,
}

impl ScriptEngine {
    /// Creates a new `ScriptEngine` from configuration.
    #[must_use]
    pub fn new(config: ScriptEngineConfig) -> Self {
        Self {
            config: Arc::new(config),
        }
    }

    /// Strips TypeScript annotations and validates JS syntax by compiling inside Boa.
    ///
    /// # Errors
    /// Returns an error with syntax details if the transpiled script fails to parse.
    pub fn validate_script(&self, source: &str) -> Result<String> {
        let wrapped = prepare_executable_js(source);
        let mut ctx = self.build_boa_context()?;
        boa_engine::Script::parse(Source::from_bytes(wrapped.as_bytes()), None, &mut ctx)
            .map_err(|err| anyhow!("script syntax error: {err}"))?;
        Ok(wrapped)
    }

    /// Executes a script synchronously within strict Boa VM limits against `input_ctx`,
    /// restoring all read-only fields afterward.
    ///
    /// # Errors
    /// Returns an error if parsing, execution, loop/recursion/timeout limits, or JSON
    /// round-tripping fails.
    pub fn execute_sync(&self, source: &str, input_ctx: &ScriptContext) -> Result<ScriptContext> {
        let started = Instant::now();
        let timeout = Duration::from_millis(self.config.timeout_ms.max(1));
        let wrapped = prepare_executable_js(source);

        let mut boa = self.build_boa_context()?;
        let ctx_json = serde_json::to_value(input_ctx)
            .context("failed to serialize ScriptContext to JSON value")?;

        let ctx_val = JsValue::from_json(&ctx_json, &mut boa)
            .map_err(|err| anyhow!("failed to convert ScriptContext JSON into JS VM: {err}"))?;

        boa.register_global_property(
            js_string!("__linguist_input_ctx"),
            ctx_val,
            boa_engine::property::Attribute::all(),
        )
        .map_err(|err| anyhow!("failed to bind input ctx in JS VM: {err}"))?;

        let script =
            boa_engine::Script::parse(Source::from_bytes(wrapped.as_bytes()), None, &mut boa)
                .map_err(|err| anyhow!("script syntax error: {err}"))?;

        let result = script
            .evaluate(&mut boa)
            .map_err(|err| anyhow!("script runtime error: {err}"))?;

        if started.elapsed() > timeout {
            return Err(anyhow!(
                "script execution exceeded {}ms budget ({}ms)",
                timeout.as_millis(),
                started.elapsed().as_millis()
            ));
        }

        let mut json_out = result
            .to_json(&mut boa)
            .map_err(|err| anyhow!("failed to extract ScriptContext JSON output: {err}"))?;
        normalize_whole_json_numbers(&mut json_out);

        let mut mutated: ScriptContext = serde_json::from_value(json_out)
            .context("script mutated ScriptContext into incompatible shape")?;

        // Enforce immutable fields regardless of script mutations.
        enforce_readonly_fields(input_ctx, &mut mutated);
        Ok(mutated)
    }

    /// Runs `execute_sync` inside a blocking task guarded by `tokio::time::timeout`.
    ///
    /// # Errors
    /// Returns an error if the task times out or fails execution.
    pub async fn execute(&self, source: &str, input_ctx: &ScriptContext) -> Result<ScriptContext> {
        let engine = self.clone();
        let src = source.to_string();
        let ctx_clone = input_ctx.clone();
        let timeout_ms = self.config.timeout_ms.max(1);

        let handle = tokio::task::spawn_blocking(move || engine.execute_sync(&src, &ctx_clone));

        match tokio::time::timeout(Duration::from_millis(timeout_ms), handle).await {
            Ok(join_res) => join_res.context("script worker task panicked")?,
            Err(_) => Err(anyhow!("script execution timed out after {timeout_ms}ms")),
        }
    }

    /// Initializes a fresh, isolated `boa_engine::Context` with sandbox limits.
    fn build_boa_context(&self) -> Result<Context> {
        let mut ctx = boa_engine::context::ContextBuilder::new()
            .host_hooks(&DEFAULT_SANDBOX_HOOKS)
            .build()
            .map_err(|err| anyhow!("failed to initialize Boa JS context: {err}"))?;

        let limits = ctx.runtime_limits_mut();
        // ~50_000 iterations aborts infinite loops (`while(true){}`) within a few ms.
        limits.set_loop_iteration_limit(50_000);
        limits.set_recursion_limit(256);
        limits.set_stack_size_limit(8_192);
        let _ = self.config.memory_limit_mb;

        Ok(ctx)
    }
}

/// Converts JS whole-number `f64` values (e.g. `400000.0` from `Number(...)` or `Math.min`)
/// back to JSON integers so upstream strict schema validators accept integer fields like `max_tokens`.
fn normalize_whole_json_numbers(val: &mut serde_json::Value) {
    match val {
        serde_json::Value::Number(num) => {
            if !num.is_i64()
                && !num.is_u64()
                && let Some(f) = num.as_f64()
                && f.is_finite()
                && f.fract() == 0.0
                && (-9_007_199_254_740_991.0..=9_007_199_254_740_991.0).contains(&f)
            {
                #[allow(clippy::cast_possible_truncation)]
                let int_val = f as i64;
                *num = serde_json::Number::from(int_val);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                normalize_whole_json_numbers(item);
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values_mut() {
                normalize_whole_json_numbers(item);
            }
        }
        _ => {}
    }
}

/// Restores read-only fields on `mutated` from `original` so scripts cannot forge
/// immutable stage/entity/request metadata.
fn enforce_readonly_fields(original: &ScriptContext, mutated: &mut ScriptContext) {
    mutated.stage = original.stage;
    mutated.project.clone_from(&original.project);
    mutated.call_model.clone_from(&original.call_model);
    mutated.provider.clone_from(&original.provider);
    mutated.model.clone_from(&original.model);
    mutated.route.rule_id.clone_from(&original.route.rule_id);
    mutated.request.uid.clone_from(&original.request.uid);
    mutated.request.attempt = original.request.attempt;
    mutated
        .request
        .signals
        .clone_from(&original.request.signals);
}

/// Strips TypeScript annotations and wraps either an `export default function ...`
/// module or inline statements into an expression returning the resulting `ctx`.
#[must_use]
pub fn prepare_executable_js(source: &str) -> String {
    let stripped = strip_typescript_annotations(source);
    let trimmed = stripped.trim();

    if let Some(after_export) = strip_export_default_fn(trimmed) {
        format!(
            "const __linguist_entry = {after_export};\n\
             const __linguist_ret = __linguist_entry(__linguist_input_ctx);\n\
             (__linguist_ret && typeof __linguist_ret === 'object') ? __linguist_ret : __linguist_input_ctx;"
        )
    } else {
        format!(
            "function __linguist_entry(ctx) {{\n{stripped}\n}}\n\
             const __linguist_ret = __linguist_entry(__linguist_input_ctx);\n\
             (__linguist_ret && typeof __linguist_ret === 'object') ? __linguist_ret : __linguist_input_ctx;"
        )
    }
}

/// Checks if the stripped script defines `export default function ...` and converts it
/// into an anonymous or named function expression.
fn strip_export_default_fn(code: &str) -> Option<String> {
    let rest = code.strip_prefix("export")?.trim_start();
    let rest = rest.strip_prefix("default")?.trim_start();
    if rest.starts_with("function") {
        Some(rest.to_string())
    } else {
        None
    }
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
/// template literals, regexps, and comments untouched while stripping:
/// - `interface Foo { ... }` and `type Foo = ...;` declarations
/// - `import type ...;` lines
/// - variable `: Type` annotations (`const x: number = 1`)
/// - parameter `: Type` / `?: Type` annotations (`(ctx: ScriptContext)`)
/// - return `: Type` annotations (`): ScriptContext | void {` or `): number =>`)
/// - `as Type` assertions (`expr as string`, `expr as Record<string, unknown>`)
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
            && tok.text == "as"
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

/// Processes punctuation tokens (`?`, `(`, `)`, `:`, `;`) or emits the token text unchanged.
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

/// Checks if `as` at `idx` is a TypeScript `expr as Type` assertion.
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
    // Avoid mistaking `import * as foo` or `import { a as b }` for a type cast.
    if tokens[prev].text == "*" {
        return false;
    }
    if let Some(prev2) = prev_non_ws_idx(tokens, prev)
        && matches!(tokens[prev2].text.as_str(), "{" | ",")
    {
        // Could be `{ x as y }` inside import specifier; check backward for `import`.
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
            || stop == TypeStop::AsExpr && tok.text == "as")
        {
            seen_type_token = true;
        }

        idx += 1;
    }

    idx
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::{Map, json};

    use super::*;
    use crate::models::{
        CallModelMeta, CandidateItem, CandidateMetrics, ModelMeta, ProjectMeta, ProviderMeta,
        RequestSignals, RequestState, RouteEndpoint, RouteState, ScriptStage,
    };

    fn sample_candidates() -> Vec<CandidateItem> {
        vec![
            CandidateItem {
                provider: ProviderMeta {
                    id: "codex".to_string(),
                    name: "Codex".to_string(),
                    icon: Some("openai".to_string()),
                },
                model: ModelMeta {
                    id: "gpt-6.1-sol".to_string(),
                    name: "GPT 6.1 Sol".to_string(),
                    icon: Some("openai".to_string()),
                    url: "http://127.0.0.1:8318/v1".to_string(),
                    supports_reasoning_effort: None,
                    tool_calling: Some(true),
                    vision: Some(true),
                    thinking: Some(true),
                    streaming: Some(true),
                    max_input_tokens: Some(500_000),
                    max_output_tokens: Some(16_000),
                },
                metrics: CandidateMetrics {
                    avg_decode_tps: Some(120.0),
                    p50_decode_tps: Some(115.0),
                    avg_ttft_ms: Some(300.0),
                    error_rate: Some(0.0),
                },
            },
            CandidateItem {
                provider: ProviderMeta {
                    id: "opencode".to_string(),
                    name: "Opencode".to_string(),
                    icon: Some("opencode".to_string()),
                },
                model: ModelMeta {
                    id: "qwen3.8-max".to_string(),
                    name: "Qwen3.8 Max".to_string(),
                    icon: Some("qwen-color".to_string()),
                    url: "https://opencode.ai/zen/go/v1".to_string(),
                    supports_reasoning_effort: Some(vec![
                        "low".to_string(),
                        "medium".to_string(),
                        "xhigh".to_string(),
                    ]),
                    tool_calling: Some(true),
                    vision: Some(true),
                    thinking: Some(true),
                    streaming: Some(true),
                    max_input_tokens: Some(1_000_000),
                    max_output_tokens: Some(131_072),
                },
                metrics: CandidateMetrics {
                    avg_decode_tps: Some(95.0),
                    p50_decode_tps: Some(92.0),
                    avg_ttft_ms: Some(250.0),
                    error_rate: Some(0.0),
                },
            },
        ]
    }

    fn sample_context() -> ScriptContext {
        let mut proj_meta = Map::new();
        proj_meta.insert("sessionId".to_string(), json!("coding-main"));
        proj_meta.insert("maxCharsLimit".to_string(), json!(400_000));

        let mut cm_meta = Map::new();
        cm_meta.insert("defaultEffort".to_string(), json!("high"));
        cm_meta.insert("preferSpeed".to_string(), json!(true));

        let mut body = Map::new();
        body.insert("model".to_string(), json!("smart-coder"));
        body.insert("temperature".to_string(), json!(0.7));
        body.insert(
            "messages".to_string(),
            json!([{"role": "user", "content": "hello"}]),
        );

        ScriptContext {
            stage: ScriptStage::Project,
            project: ProjectMeta {
                id: "coding".to_string(),
                name: "VS Code Coding".to_string(),
                icon: Some("githubcopilot".to_string()),
                meta: proj_meta,
            },
            call_model: CallModelMeta {
                id: "smart-coder".to_string(),
                name: "Smart Coder".to_string(),
                icon: Some("cursor".to_string()),
                meta: cm_meta,
            },
            provider: Some(ProviderMeta {
                id: "opencode".to_string(),
                name: "Opencode".to_string(),
                icon: Some("opencode".to_string()),
            }),
            model: Some(ModelMeta {
                id: "qwen3.8-max".to_string(),
                name: "Qwen3.8 Max".to_string(),
                icon: Some("qwen-color".to_string()),
                url: "https://opencode.ai/zen/go/v1".to_string(),
                supports_reasoning_effort: Some(vec![
                    "low".to_string(),
                    "medium".to_string(),
                    "xhigh".to_string(),
                ]),
                tool_calling: Some(true),
                vision: Some(true),
                thinking: Some(true),
                streaming: Some(true),
                max_input_tokens: Some(1_000_000),
                max_output_tokens: Some(131_072),
            }),
            route: RouteState {
                rule_id: "coding-smart-coder".to_string(),
                candidates: sample_candidates(),
                target: None,
                fallbacks: Vec::new(),
                rewrite_response_model: true,
            },
            request: RequestState {
                uid: "00000000-0000-0000-0000-000000000001".to_string(),
                attempt: 1,
                url: "https://opencode.ai/zen/go/v1/chat/completions".to_string(),
                headers: BTreeMap::new(),
                body,
                signals: RequestSignals {
                    is_stream: true,
                    has_vision_images: false,
                    has_tools: false,
                    message_count: 1,
                    estimated_input_chars: 5,
                },
            },
            state: Map::new(),
            reject: None,
        }
    }

    #[test]
    fn typescript_stripping_and_readonly_protection_work() {
        let engine = ScriptEngine::new(ScriptEngineConfig::default());
        let ts_script = r#"
            interface LocalCfg { limit: number; }
            type Mode = "fast" | "safe";
            export default function handle(ctx: ScriptContext): ScriptContext | void {
                const limit: number = Number(ctx.project.meta.maxCharsLimit ?? 500000);
                const mode: Mode = "fast" as Mode;
                ctx.project.id = "tampered";
                ctx.stage = "provider";
                ctx.request.headers['x-session'] = String(ctx.project.meta.sessionId) + ':' + mode;
                ctx.request.body.reasoning_effort ??= ctx.callModel.meta.defaultEffort;
                delete ctx.request.body.temperature;
                ctx.state.budget = limit;
            }
        "#;

        let initial = sample_context();
        let res = engine.execute_sync(ts_script, &initial);
        assert!(res.is_ok(), "unexpected script failure: {res:?}");
        if let Ok(out) = res {
            // Read-only properties preserved despite script tamper attempt.
            assert_eq!(out.project.id, "coding");
            assert_eq!(out.stage, ScriptStage::Project);
            // Mutable properties updated and deleted cleanly.
            assert_eq!(
                out.request.headers.get("x-session").map(String::as_str),
                Some("coding-main:fast")
            );
            assert_eq!(
                out.request.body.get("reasoning_effort"),
                Some(&json!("high"))
            );
            assert!(!out.request.body.contains_key("temperature"));
            assert_eq!(out.state.get("budget"), Some(&json!(400_000)));
        }
    }

    #[test]
    fn infinite_loop_is_aborted_within_budget() {
        let engine = ScriptEngine::new(ScriptEngineConfig {
            timeout_ms: 50,
            memory_limit_mb: 32,
            fallback_status_codes: vec![429, 500],
        });
        let ctx = sample_context();
        let res = engine.execute_sync("while (true) {}", &ctx);
        assert!(res.is_err());
    }

    #[test]
    fn plan_examples_for_all_five_stages_execute_cleanly() {
        let engine = ScriptEngine::new(ScriptEngineConfig::default());
        let mut ctx = sample_context();

        // Stage 1: project script filters out codex
        let s1 =
            "ctx.route.candidates = ctx.route.candidates.filter(c => c.provider.id !== 'codex');";
        ctx = engine
            .execute_sync(s1, &ctx)
            .unwrap_or_else(|_| sample_context());
        assert_eq!(ctx.route.candidates.len(), 1);
        assert_eq!(ctx.route.candidates[0].provider.id, "opencode");

        // Stage 2: callModel script
        let s2 = "ctx.request.body.reasoning_effort ??= ctx.callModel.meta.defaultEffort; ctx.state.preferSpeed = Boolean(ctx.callModel.meta.preferSpeed);";
        ctx = engine
            .execute_sync(s2, &ctx)
            .unwrap_or_else(|_| sample_context());
        assert_eq!(
            ctx.request.body.get("reasoning_effort"),
            Some(&json!("high"))
        );

        // Stage 3: route script
        let s3 = "const pool = ctx.route.candidates; ctx.route.target = { providerId: pool[0].provider.id, modelId: pool[0].model.id };";
        ctx = engine
            .execute_sync(s3, &ctx)
            .unwrap_or_else(|_| sample_context());
        assert_eq!(
            ctx.route.target,
            Some(RouteEndpoint {
                provider_id: "opencode".to_string(),
                model_id: "qwen3.8-max".to_string()
            })
        );

        // Stage 4: model script upgrades 'high' -> 'xhigh'
        let s4 = "const supported = ctx.model?.supportsReasoningEffort ?? []; if (ctx.request.body.reasoning_effort === 'high' && !supported.includes('high') && supported.includes('xhigh')) { ctx.request.body.reasoning_effort = 'xhigh'; }";
        ctx = engine
            .execute_sync(s4, &ctx)
            .unwrap_or_else(|_| sample_context());
        assert_eq!(
            ctx.request.body.get("reasoning_effort"),
            Some(&json!("xhigh"))
        );

        // Stage 5: provider script injects headers
        let s5 = "ctx.request.headers['accept'] = 'application/json'; ctx.request.headers['x-opencode-session'] = String(ctx.project.meta.sessionId ?? '1');";
        ctx = engine
            .execute_sync(s5, &ctx)
            .unwrap_or_else(|_| sample_context());
        assert_eq!(
            ctx.request
                .headers
                .get("x-opencode-session")
                .map(String::as_str),
            Some("coding-main")
        );
    }
}
