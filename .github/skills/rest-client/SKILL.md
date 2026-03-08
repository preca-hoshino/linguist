---
name: rest-client
description: Send HTTP requests directly in VS Code using the REST Client extension. Use for API testing, debugging, and development workflows including GET/POST/PUT/DELETE requests, GraphQL queries, variables, environments, and various authentication methods.
license: Complete terms in LICENSE.txt
---

# REST Client Skill

The REST Client extension for VS Code enables efficient API testing and HTTP request workflows directly in your editor. Send requests, manage responses, chain requests with variables, and switch between environments—all without leaving the code editor.

## Quick Start

### Basic Request

Create a `.http` or `.rest` file:

```
GET https://api.example.com/users/1
```

Click "Send Request" above the line (or press `Ctrl+Alt+R` / `Cmd+Alt+R`).

### With Headers and Body

```
POST https://api.example.com/users HTTP/1.1
Content-Type: application/json

{
    "name": "John Doe",
    "email": "john@example.com"
}
```

### Multiple Requests

Separate with `###` delimiter:

```
GET https://api.example.com/users/1

###

POST https://api.example.com/users
Content-Type: application/json

{
    "name": "Jane Doe"
}
```

## Core Concepts

### Request Format

Format: `Method URL HTTP-Version`

Minimal examples:
```
https://example.com/api        # GET by default
GET https://example.com/api    # Explicit GET
POST https://example.com/api   # POST request
```

See [requests.md](references/requests.md) for complete request format documentation including query strings, headers, bodies, multipart form data, cURL support, and GraphQL.

### Variables

Use `{{variableName}}` syntax to reference variables:

```
@baseUrl = https://api.example.com
@port = 8080

GET {{baseUrl}}:{{port}}/users
```

**Environment variables**: Store credentials and URLs in VS Code settings by environment (dev, staging, prod).

**Request variables**: Chain requests—use output from one request in the next:

```
# @name login
POST https://api.example.com/login

###

@token = {{login.response.headers.X-Auth-Token}}
GET https://api.example.com/profile
Authorization: Bearer {{token}}
```

**Interactive variables**: Prompt for user input during request execution with `@prompt`.

**System variables**: Generate UUIDs, timestamps, random values with `{{$guid}}`, `{{$timestamp}}`, `{{$randomInt}}`, etc.

Complete variable documentation: See [variables.md](references/variables.md).

### Environments

Switch between dev, staging, and production configurations:

```json
"rest-client.environmentVariables": {
    "dev": {
        "host": "localhost:3000",
        "token": "dev-token"
    },
    "prod": {
        "host": "api.example.com",
        "token": "prod-token"
    }
}
```

Switch via:
- Bottom right status bar click
- Shortcut: `Ctrl+Alt+E` / `Cmd+Alt+E`
- Command palette: "Rest Client: Switch Environment"

### Authentication

Supports multiple auth schemes:

- **Basic Auth**: Username/password with auto Base64 encoding
- **Digest Auth**: Challenge-response authentication
- **Bearer Tokens**: JWT and similar token-based auth
- **SSL Certificates**: Client certificate authentication
- **AWS Signature v4**: For AWS API requests
- **Azure AD**: Azure AD token generation

Details: See [authentication.md](references/authentication.md).

Example:
```
GET https://api.example.com/users
Authorization: Bearer {{authToken}}
```

## Response and Request Management

### Send & Manage Requests

- **Send**: `Ctrl+Alt+R` (Windows/Linux) / `Cmd+Alt+R` (macOS)
- **Cancel**: `Ctrl+Alt+K` / `Cmd+Alt+K`
- **Rerun last**: `Ctrl+Alt+L` / `Cmd+Alt+L`
- **History**: `Ctrl+Alt+H` / `Cmd+Alt+H` (shows last 50 requests)
- **Generate code**: `Ctrl+Alt+C` / `Cmd+Alt+C` (Python, JavaScript, etc.)

### Save Responses

- Save full response (headers + body)
- Save only response body (auto-detects format)
- Copy as cURL command

### Request Options

Add settings as comments before requests:

```
# @no-cookie-jar
# @no-redirect
GET https://example.com/api/data
```

Details and all response management features: See [response-handling.md](references/response-handling.md).

## Common Workflows

### API Testing

```
### Create user
POST https://api.example.com/users
Content-Type: application/json

{
    "name": "John Doe",
    "email": "john@example.com"
}

###

@userId = {{POST_response.body.$.id}}

### Get user
GET https://api.example.com/users/{{userId}}

###

### Update user
PUT https://api.example.com/users/{{userId}}
Content-Type: application/json

{
    "name": "John Updated"
}

###

### Delete user
DELETE https://api.example.com/users/{{userId}}
```

### Authentication Flow

```
# @name login
POST https://api.example.com/auth/login
Content-Type: application/json

{
    "username": "{{username}}",
    "password": "{{password}}"
}

###

@authToken = {{login.response.body.token}}

# @name getProfile
GET https://api.example.com/users/me
Authorization: Bearer {{authToken}}
```

### Environment-Specific Requests

Store configuration in environment variables, then reference in requests:

```
GET https://{{host}}/api/{{version}}/users
Authorization: {{token}}
```

With environments configured in settings, simply switch environment and all variables update.

## File Language Support

REST Client automatically activates for:
- `.http` files
- `.rest` files

Features include:
- Syntax highlighting
- Auto-completion for methods, headers, MIME types
- Comment support (`#` or `//`)
- CodeLens links ("Send Request", "Generate Code")
- Symbol navigation

## Tips & Best Practices

1. **Use variables** for dynamic values (hosts, tokens, IDs)
2. **Name requests** with `# @name requestName` for easier chaining
3. **Set environments** for dev/staging/production separation
4. **Organize with `###`** to group related requests
5. **Use request history** to quickly rerun previous requests
6. **Generate code snippets** to integrate into applications
7. **Chain requests** with request variables for complex workflows
8. **Leverage environments** to avoid hardcoding configuration

## Configuration

Common settings in VS Code:

```json
{
    "rest-client.followredirect": true,
    "rest-client.rememberCookiesForSubsequentRequests": true,
    "rest-client.defaultHeaders": {
        "User-Agent": "vscode-restclient"
    }
}
```

Full settings reference: See [settings.md](references/settings.md).

## Troubleshooting

### Request Not Sending?

- Ensure file is in HTTP language mode (bottom right corner)
- Use `.http` or `.rest` file extension

### Variables Not Working?

- Check variable names match exactly (case-sensitive)
- For environment variables, confirm correct environment is selected
- For request variables, ensure source request has `# @name` defined

### Other Issues?

- Check REST output panel for detailed logs
- Use hover to preview variable values
- Compare with working requests in history

Complete troubleshooting guide: See [troubleshooting.md](references/troubleshooting.md).

## Resources

- **Marketplace**: https://marketplace.visualstudio.com/items?itemName=humao.rest-client
- **GitHub**: https://github.com/Huachao/vscode-restclient
- **Wiki**: https://github.com/Huachao/vscode-restclient/wiki

