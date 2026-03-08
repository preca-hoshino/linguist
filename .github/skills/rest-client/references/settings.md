# VS Code Settings

## Configuration Reference

Key settings for REST Client extension:

```json
{
    "rest-client.followredirect": true,
    "rest-client.defaultHeaders": {
        "User-Agent": "vscode-restclient",
        "Accept-Encoding": "gzip"
    },
    "rest-client.timeoutinmilliseconds": 0,
    "rest-client.showResponseInDifferentTab": false,
    "rest-client.rememberCookiesForSubsequentRequests": true,
    "rest-client.environmentVariables": {},
    "rest-client.certificates": {},
    "rest-client.previewResponseInUntitledDocument": false,
    "rest-client.previewOption": "full",
    "rest-client.fontSize": 13,
    "rest-client.fontFamily": "Menlo, Monaco, Consolas, \"Droid Sans Mono\", \"Courier New\", monospace, \"Droid Sans Fallback\"",
    "rest-client.fontWeight": "normal"
}
```

## Common Settings

### Follow Redirects

```json
"rest-client.followredirect": true
```

Automatically follow 3XX redirects in responses.

### Default Headers

```json
"rest-client.defaultHeaders": {
    "User-Agent": "vscode-restclient",
    "Accept-Encoding": "gzip"
}
```

Headers automatically added to all requests.

### Timeout

```json
"rest-client.timeoutinmilliseconds": 0
```

Request timeout in milliseconds. 0 = no timeout.

### Cookie Jar

```json
"rest-client.rememberCookiesForSubsequentRequests": true
```

Persist cookies across requests in the same session.

### Response Preview

```json
"rest-client.showResponseInDifferentTab": false,
"rest-client.previewOption": "full"
```

Configure where and how responses are displayed.

### Fonts

```json
"rest-client.fontSize": 13,
"rest-client.fontFamily": "...",
"rest-client.fontWeight": "normal"
```

Customize editor appearance.
