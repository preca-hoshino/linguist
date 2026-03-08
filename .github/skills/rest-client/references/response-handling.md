# Response Handling

## Save Full Response

- Click "Save Full Response" icon in response preview tab
- Saves complete response (headers + body)

## Save Response Body

- Click "Save Response Body" icon
- Saves only the response body
- Extension determined by Content-Type

## Fold/Unfold Response

- Click "More Actions..." button
- Select "Fold Response" or "Unfold Response"

## Code Snippet Generation

Generate code for requests in various languages:

- Shortcut: `Ctrl+Alt+C` / `Cmd+Alt+C`
- Right-click menu: "Generate Code Snippet"
- Command palette: "Rest Client: Generate Code Snippet"

Supported languages: Python, JavaScript, and more.

## Request Management

### Send Request

- Click "Send Request" link above the request
- Shortcut: `Ctrl+Alt+R` (Windows/Linux) / `Cmd+Alt+R` (macOS)
- Right-click menu: "Send Request"
- Command palette: "Rest Client: Send Request"

### Cancel Request

- Click the waiting spin icon in status bar
- Shortcut: `Ctrl+Alt+K` / `Cmd+Alt+K`
- Command palette: "Rest Client: Cancel Request"

### Rerun Last Request

- Shortcut: `Ctrl+Alt+L` / `Cmd+Alt+L`
- Command palette: "Rest Client: Rerun Last Request"

### Request History

- Shortcut: `Ctrl+Alt+H` / `Cmd+Alt+H`
- Command palette: "Rest Client: Request History"
- Shows last 50 requests

### Clear Request History

- Command palette: "Rest Client: Clear Request History"

## Per-Request Settings

Add settings as comments before the request:

```
# @note Use for request confirmation, especially for critical request
# @no-redirect Don't follow the 3XX response as redirects
# @no-cookie-jar Don't save cookies in the cookie jar

GET https://example.com/api/data
```

## Keyboard Shortcuts

| Shortcut                       | Action                |
| ------------------------------ | --------------------- |
| `Ctrl+Alt+R` / `Cmd+Alt+R`     | Send request          |
| `Ctrl+Alt+K` / `Cmd+Alt+K`     | Cancel request        |
| `Ctrl+Alt+L` / `Cmd+Alt+L`     | Rerun last request    |
| `Ctrl+Alt+H` / `Cmd+Alt+H`     | Request history       |
| `Ctrl+Alt+E` / `Cmd+Alt+E`     | Switch environment    |
| `Ctrl+Alt+C` / `Cmd+Alt+C`     | Generate code snippet |
| `Ctrl+Shift+O` / `Cmd+Shift+O` | Navigate to symbols   |
