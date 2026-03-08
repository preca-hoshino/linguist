# Variables System

## Environment Variables

Define environments in VS Code settings:

```json
"rest-client.environmentVariables": {
    "$shared": {
        "version": "v1",
        "prodToken": "foo",
        "nonProdToken": "bar"
    },
    "local": {
        "version": "v2",
        "host": "localhost",
        "token": "{{$shared nonProdToken}}",
        "secretKey": "devSecret"
    },
    "production": {
        "host": "example.com",
        "token": "{{$shared prodToken}}",
        "secretKey": "prodSecret"
    }
}
```

### Switch Environments

- Click environment name at bottom right
- Shortcut: `Ctrl+Alt+E` / `Cmd+Alt+E`
- Command palette: "Rest Client: Switch Environment"

## File Variables

Syntax: `@variableName = variableValue`

Example:
```
@hostname = api.example.com
@port = 8080
@host = {{hostname}}:{{port}}
@contentType = application/json
@createdAt = {{$datetime iso8601}}
@modifiedBy = {{$processEnv USERNAME}}

###

@name = hello

GET https://{{host}}/authors/{{name}} HTTP/1.1
```

## Request Variables

For chaining requests:

```
@baseUrl = https://example.com/api

# @name login
POST {{baseUrl}}/api/login HTTP/1.1
Content-Type: application/x-www-form-urlencoded

name=foo&password=bar

###

@authToken = {{login.response.headers.X-AuthToken}}

# @name createComment
POST {{baseUrl}}/comments HTTP/1.1
Authorization: {{authToken}}
Content-Type: application/json

{
    "content": "fake content"
}

###

@commentId = {{createComment.response.body.$.id}}

# @name getCreatedComment
GET {{baseUrl}}/comments/{{commentId}} HTTP/1.1
Authorization: {{authToken}}
```

## Prompt Variables

Interactive variables that prompt for input:

```
###
# @prompt username
# @prompt refCode Your reference code display on webpage
# @prompt otp Your one-time password in your mailbox
POST https://{{host}}/verify-otp/{{refCode}} HTTP/1.1
Content-Type: {{contentType}}

{
    "username": "{{username}}",
    "otp": "{{otp}}"
}
```

## System Variables

Format: `{{$variableName}}`

### Available System Variables

| Variable                                              | Description                                              |
| ----------------------------------------------------- | -------------------------------------------------------- |
| `{{$guid}}`                                           | RFC 4122 v4 UUID                                         |
| `{{$randomInt min max}}`                              | Random integer between min (included) and max (excluded) |
| `{{$timestamp [offset option]}}`                      | UTC timestamp                                            |
| `{{$datetime rfc1123\|iso8601 [offset option]}}`      | Datetime string in specified format                      |
| `{{$localDatetime rfc1123\|iso8601 [offset option]}}` | Local datetime string                                    |
| `{{$processEnv [%]envVarName}}`                       | Local machine environment variable                       |
| `{{$dotenv [%]variableName}}`                         | Value from .env file                                     |
| `{{$aadToken ...}}`                                   | Azure AD token                                           |
| `{{$aadV2Token ...}}`                                 | Azure AD v2 token                                        |

### Offset Options

- `y` (year)
- `M` (month)
- `w` (week)
- `d` (day)
- `h` (hour)
- `m` (minute)
- `s` (second)
- `ms` (millisecond)

### Example

```
POST https://api.example.com/comments HTTP/1.1
Content-Type: application/json

{
    "user_name": "{{$dotenv USERNAME}}",
    "request_id": "{{$guid}}",
    "updated_at": "{{$timestamp}}",
    "created_at": "{{$timestamp -1 d}}",
    "review_count": "{{$randomInt 5 200}}",
    "custom_date": "{{$datetime 'YYYY-MM-DD'}}",
    "local_custom_date": "{{$localDatetime 'YYYY-MM-DD'}}"
}
```
