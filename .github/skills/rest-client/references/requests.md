# Request Format and Components

## Request Line

Format: `Method SP Request-URI SP HTTP-Version`

Examples:
```
GET https://example.com/comments/1 HTTP/1.1
GET https://example.com/comments/1
https://example.com/comments/1
```

If method is omitted, GET is used by default.

## Query Strings

### Inline Query Parameters

```
GET https://example.com/comments?page=2&pageSize=10
```

### Multi-line Query Parameters

```
GET https://example.com/comments
    ?page=2
    &pageSize=10
```

## Request Headers

Format: `field-name: field-value`

Example:
```
User-Agent: rest-client
Accept-Language: en-GB,en-US;q=0.8,en;q=0.6,zh-CN;q=0.4
Content-Type: application/json
```

## Request Body

Add a blank line after headers, then include the body content.

### JSON Body

```
POST https://example.com/comments HTTP/1.1
Content-Type: application/json

{
    "name": "sample",
    "time": "Wed, 21 Oct 2015 18:27:50 GMT"
}
```

### XML Body

```
POST https://example.com/comments HTTP/1.1
Content-Type: application/xml

<request>
    <name>sample</name>
    <time>Wed, 21 Oct 2015 18:27:50 GMT</time>
</request>
```

### File as Body

Absolute path:
```
POST https://example.com/comments HTTP/1.1
Content-Type: application/xml

< C:\Users\Default\Desktop\demo.xml
```

Relative path:
```
POST https://example.com/comments HTTP/1.1
Content-Type: application/xml

< ./demo.xml
```

With variable processing:
```
POST https://example.com/comments HTTP/1.1
Content-Type: application/xml

<@ ./demo.xml
```

With custom encoding:
```
POST https://example.com/comments HTTP/1.1
Content-Type: application/xml

<@latin1 ./demo.xml
```

### Multipart Form Data

```
POST https://api.example.com/user/upload
Content-Type: multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW

------WebKitFormBoundary7MA4YWxkTrZu0gW
Content-Disposition: form-data; name="text"

title
------WebKitFormBoundary7MA4YWxkTrZu0gW
Content-Disposition: form-data; name="image"; filename="1.png"
Content-Type: image/png

< ./1.png
------WebKitFormBoundary7MA4YWxkTrZu0gW--
```

### URL-Encoded Form Data

```
POST https://api.example.com/login HTTP/1.1
Content-Type: application/x-www-form-urlencoded

name=foo
&password=bar
```

## Multiple Requests in One File

Separate requests with `###` delimiter:

```
GET https://example.com/comments/1 HTTP/1.1

###

GET https://example.com/topics/1 HTTP/1.1

###

POST https://example.com/comments HTTP/1.1
content-type: application/json

{
    "name": "sample",
    "time": "Wed, 21 Oct 2015 18:27:50 GMT"
}
```

## GraphQL Requests

Add `X-Request-Type: GraphQL` header:

```
POST https://api.github.com/graphql
Content-Type: application/json
Authorization: Bearer xxx
X-REQUEST-TYPE: GraphQL

query ($name: String!, $owner: String!) {
  repository(name: $name, owner: $owner) {
    name
    fullName: nameWithOwner
    description
    diskUsage
    forkCount
    stargazers(first: 5) {
        totalCount
        nodes {
            login
            name
        }
    }
    watchers {
        totalCount
    }
  }
}

{
    "name": "vscode-restclient",
    "owner": "Huachao"
}
```

## cURL Requests

REST Client can parse cURL commands directly:

```
curl -X POST https://example.com/api/data \
  -H "Content-Type: application/json" \
  -d '{"key": "value"}'
```

### Supported cURL Options

- `-X, --request`
- `-L, --location, --url`
- `-H, --header` (no @ support)
- `-I, --head`
- `-b, --cookie` (no cookie jar file support)
- `-u, --user` (Basic auth support only)
- `-d, --data, --data-ascii, --data-binary, --data-raw`

### Copy Request as cURL

Use the command palette: "Rest Client: Copy Request As cURL"
