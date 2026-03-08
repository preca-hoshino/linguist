# Authentication Methods

## Basic Auth

Three formats supported:

### Raw Username:Password

```
GET https://httpbin.org/basic-auth/user/passwd HTTP/1.1
Authorization: Basic user:passwd
```

### Base64 Encoded

```
GET https://httpbin.org/basic-auth/user/passwd HTTP/1.1
Authorization: Basic dXNlcjpwYXNzd2Q=
```

### Space-Separated (Auto-Encoded)

```
GET https://httpbin.org/basic-auth/user/passwd HTTP/1.1
Authorization: Basic user passwd
```

## Digest Auth

```
GET https://httpbin.org/digest-auth/auth/user/passwd
Authorization: Digest user passwd
```

## SSL Client Certificates

Configure in VS Code settings:

```json
"rest-client.certificates": {
    "localhost:8081": {
        "cert": "/Users/demo/Certificates/client.crt",
        "key": "/Users/demo/Keys/client.key"
    },
    "example.com": {
        "pfx": "/Users/demo/Certificates/clientcert.p12",
        "passphrase": "123456"
    }
}
```

## Azure Active Directory

Use system variable `{{$aadToken}}` (see Variables documentation)

## AWS Signature v4

```
GET https://httpbin.org/aws-auth HTTP/1.1
Authorization: AWS <accessId> <accessKey> [token:<sessionToken>] [region:<regionName>] [service:<serviceName>]
```
