# ⚡ API Client

A Postman/Insomnia-like API testing tool built with Python + vanilla JS.

## Requirements

- **Python 3.7+** (no external packages needed — uses stdlib only)
- Modern web browser (Chrome, Firefox, Safari, Edge)

## Quick Start

```bash
# Clone the repository
git clone https://github.com/RobbyRaffly/API_Client.git
cd API_Client

# Run the server
python3 server.py

# Or specify a custom port
python3 server.py --port 8080
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
| Collections | Save and organize requests in folders |
| History | Auto-saves last 100 requests |
| Environments | Variable substitution with `{{variable}}` syntax |
| Pre-Script | JavaScript code executed before request |
| Post-Script | JavaScript code executed after response |
| Response | Pretty-print JSON, syntax highlighting, copy, download |
| SSL | Self-signed certs accepted by default |
| Theme | Light/Dark mode toggle |
| cURL | Import/Export cURL commands |

### Context Menu (Right-Click)

Select text in any input field and right-click to access:

**Encode:**
- Base64 Encode
- URL Encode
- HTML Encode
- JSON Stringify

**Decode:**
- Base64 Decode
- URL Decode  
- HTML Decode
- JSON Parse

**Hash:**
- MD5
- SHA1
- SHA256
- SHA512

**Format:**
- Format JSON (pretty print)
- Minify JSON

## Environment Variables

Use `{{variableName}}` in URLs, headers, or body. Set values in the Env tab.

**Built-in Variables:**
- `{{$uuid}}` - Generate random UUID
- `{{$timestamp}}` - Current Unix timestamp
- `{{$randomInt}}` - Random integer

**Example:**
```
Env variable: baseUrl = https://api.example.com
URL: {{baseUrl}}/users/{{$uuid}}
```

## Pre-Script & Post-Script

Write JavaScript code that runs before/after each request.

**Pre-Script Example:**
```javascript
// Set dynamic header
pm.request.headers.add('X-Request-ID', pm.variables.uuid());

// Set timestamp
pm.variables.set('timestamp', Date.now());
```

**Post-Script Example:**
```javascript
// Extract token from response
const token = pm.response.json().access_token;
pm.environment.set('authToken', token);

// Validate response
pm.test('Status is 200', pm.response.status === 200);
```

## Project Structure

```
API_Client/
├── server.py          # Python HTTP server (backend)
├── public/
│   ├── index.html     # Main HTML
│   ├── app.js         # Frontend JavaScript
│   └── styles.css     # Styles
├── requirements.txt   # Python dependencies (none needed)
├── .gitignore
└── README.md
```

## Data Storage

All data is stored locally in JSON files (auto-created on first run):
- `collections.json` - Saved requests and folders
- `responses.json` - Response history
- `environments.json` - Environment variables

These files are gitignored and won't be pushed to the repository.

## License

MIT
