# ⚡ API Client

A Postman/Insomnia-like API testing tool built with Python + vanilla JS.

## Requirements

- Python 3.6+ (no external packages needed — uses stdlib only)

## Run

```bash
cd api-client
python3 server.py
```

Then open **http://localhost:3737** in your browser.

## Features

| Feature | Description |
|---|---|
| HTTP Methods | GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS |
| Auth | Bearer Token, Basic Auth, API Key |
| Request Body | JSON, Form URL-Encoded, XML, Plain Text |
| Query Params | Visual key-value editor |
| Headers | Visual key-value editor |
| Collections | Save and organize requests |
| History | Auto-saves last 100 requests |
| Environments | Variable substitution with `{{variable}}` syntax |
| Response | Pretty-print JSON, syntax highlighting, copy, download |
| SSL | Self-signed certs accepted by default |

## Environment Variables

Use `{{variableName}}` in URLs, headers, or body. Set values in the Env tab.

**Example:**
- Env variable: `baseUrl = https://api.example.com`
- URL: `{{baseUrl}}/users`
