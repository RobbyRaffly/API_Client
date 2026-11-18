#!/usr/bin/env python3
"""
API Client Server - Postman/Insomnia-like tool
Uses only Python stdlib, no external dependencies needed.
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error
import urllib.parse
import ssl
import base64
import re
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

PORT = 3737
BASE_DIR = Path(__file__).parent
PUBLIC_DIR = BASE_DIR / "public"
DATA_FILE = BASE_DIR / "collections.json"
RESPONSES_FILE = BASE_DIR / "responses.json"  # Stores response history per request

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
}

# ──────────────────────────────────────────────
# Data persistence
# ──────────────────────────────────────────────
def load_data():
    if DATA_FILE.exists():
        try:
            return json.loads(DATA_FILE.read_text("utf-8"))
        except Exception:
            pass
    return {"collections": [], "history": [], "environments": []}

def save_data(data):
    DATA_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), "utf-8")

# Response history persistence (per request)
def load_responses():
    if RESPONSES_FILE.exists():
        try:
            return json.loads(RESPONSES_FILE.read_text("utf-8"))
        except Exception:
            pass
    return {}

def save_responses(data):
    RESPONSES_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), "utf-8")

def get_request_responses(req_id, limit=10):
    """Get response history for a specific request ID"""
    responses = load_responses()
    return responses.get(req_id, [])[:limit]

def add_request_response(req_id, response_data, max_history=10):
    """Add a response to request's history, keeping only max_history items"""
    responses = load_responses()
    if req_id not in responses:
        responses[req_id] = []
    # Add new response at the beginning
    responses[req_id].insert(0, {
        "id": str(int(time.time() * 1000)),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        **response_data
    })
    # Keep only max_history items
    responses[req_id] = responses[req_id][:max_history]
    save_responses(responses)
    return responses[req_id][0]

def delete_request_responses(req_id):
    """Delete all response history for a request"""
    responses = load_responses()
    if req_id in responses:
        del responses[req_id]
        save_responses(responses)

# ──────────────────────────────────────────────
# HTTP proxy engine
# ──────────────────────────────────────────────
def proxy_request(payload):
    method = (payload.get("method") or "GET").upper()
    url = (payload.get("url") or "").strip()
    headers_in = payload.get("headers") or {}
    params = payload.get("params") or {}
    body_type = payload.get("bodyType") or "none"
    body_str = payload.get("body") or ""
    auth = payload.get("auth") or {}
    timeout = int(payload.get("timeout") or 30)

    if not url:
        return {"error": "URL is required"}, 400

    # Build URL with query params
    # URL should already be cleaned by client, just add the params
    if params:
        filtered = {k: v for k, v in params.items() if k}
        if filtered:
            sep = "&" if "?" in url else "?"
            url = url + sep + urllib.parse.urlencode(filtered)

    # Build headers
    req_headers = {}
    for k, v in headers_in.items():
        if k:
            req_headers[str(k)] = str(v)

    # Add default User-Agent if not provided (to avoid Cloudflare blocking)
    if not any(k.lower() == 'user-agent' for k in req_headers.keys()):
        req_headers['User-Agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

    # Auth
    auth_type = auth.get("type", "none")
    if auth_type == "bearer" and auth.get("token"):
        req_headers["Authorization"] = f"Bearer {auth['token']}"
    elif auth_type == "basic" and auth.get("username"):
        creds = base64.b64encode(f"{auth['username']}:{auth.get('password', '')}".encode()).decode()
        req_headers["Authorization"] = f"Basic {creds}"
    elif auth_type == "apikey" and auth.get("key") and auth.get("value"):
        if auth.get("placement", "header") == "header":
            req_headers[auth["key"]] = auth["value"]

    # Build body
    body_bytes = None
    if method in ("POST", "PUT", "PATCH"):
        if body_type == "json":
            if not req_headers.get("Content-Type"):
                req_headers["Content-Type"] = "application/json"
            body_bytes = body_str.encode("utf-8") if body_str else b""
        elif body_type == "form":
            req_headers["Content-Type"] = "application/x-www-form-urlencoded"
            body_bytes = body_str.encode("utf-8") if body_str else b""
        elif body_type == "xml":
            if not req_headers.get("Content-Type"):
                req_headers["Content-Type"] = "application/xml"
            body_bytes = body_str.encode("utf-8") if body_str else b""
        elif body_type == "text":
            if not req_headers.get("Content-Type"):
                req_headers["Content-Type"] = "text/plain"
            body_bytes = body_str.encode("utf-8") if body_str else b""

    # SSL context (skip cert verification like Insomnia default)
    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE

    req = urllib.request.Request(url, data=body_bytes, headers=req_headers, method=method)
    opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ssl_ctx))

    start_ms = int(time.time() * 1000)
    try:
        with opener.open(req, timeout=timeout) as resp:
            duration = int(time.time() * 1000) - start_ms
            status = resp.status
            status_text = resp.reason or ""
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            raw = resp.read()
    except urllib.error.HTTPError as e:
        duration = int(time.time() * 1000) - start_ms
        status = e.code
        status_text = e.reason or ""
        resp_headers = {k.lower(): v for k, v in e.headers.items()} if e.headers else {}
        raw = e.read()
    except urllib.error.URLError as e:
        return {"error": str(e.reason)}, 502
    except TimeoutError:
        return {"error": "Request timed out"}, 408
    except Exception as e:
        return {"error": str(e)}, 500

    content_type = resp_headers.get("content-type", "")
    is_text = any(t in content_type for t in ("text/", "json", "xml", "html", "javascript", "yaml", "plain"))
    is_base64 = False
    if is_text or not raw:
        try:
            body_out = raw.decode("utf-8")
        except UnicodeDecodeError:
            body_out = base64.b64encode(raw).decode("ascii")
            is_base64 = True
    else:
        body_out = base64.b64encode(raw).decode("ascii")
        is_base64 = True

    return {
        "status": status,
        "statusText": status_text,
        "headers": dict(resp_headers),
        "body": body_out,
        "isBase64": is_base64,
        "duration": duration,
        "size": len(raw),
    }, 200

# ──────────────────────────────────────────────
# Request handler
# ──────────────────────────────────────────────
_lock = threading.Lock()

class APIHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # suppress default access log

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]

        if path == "/api/collections":
            d = load_data()
            return self.send_json(200, d.get("collections", []))
        if path == "/api/history":
            d = load_data()
            return self.send_json(200, d.get("history", []))
        if path == "/api/environments":
            d = load_data()
            return self.send_json(200, d.get("environments", []))

        # GET /api/requests/:reqId/responses - Get response history for a request
        m = re.match(r"^/api/requests/([^/]+)/responses$", path)
        if m:
            req_id = m.group(1)
            responses = get_request_responses(req_id)
            return self.send_json(200, responses)

        # Static files
        if path == "/":
            path = "/index.html"
        file_path = PUBLIC_DIR / path.lstrip("/")
        if file_path.exists() and file_path.is_file():
            suffix = file_path.suffix.lower()
            mime = MIME_TYPES.get(suffix, "application/octet-stream")
            body = file_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            # Always serve fresh — disable caching for development
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        path = self.path.split("?")[0]

        if path == "/api/request":
            payload = self.read_json_body()
            result, code = proxy_request(payload)
            if code == 200:
                # Save to history
                with _lock:
                    d = load_data()
                    d.setdefault("history", []).insert(0, {
                        "id": str(int(time.time() * 1000)),
                        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                        "method": payload.get("method", "GET"),
                        "url": payload.get("url", ""),
                        "status": result.get("status"),
                        "duration": result.get("duration"),
                        "request": payload,
                    })
                    d["history"] = d["history"][:100]
                    save_data(d)
            return self.send_json(code, result)

        if path == "/api/collections":
            body = self.read_json_body()
            with _lock:
                d = load_data()
                col = {"id": str(int(time.time() * 1000)), "requests": [], **body,
                       "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
                d.setdefault("collections", []).append(col)
                save_data(d)
            return self.send_json(201, col)

        if path == "/api/environments":
            body = self.read_json_body()
            with _lock:
                d = load_data()
                env = {"id": str(int(time.time() * 1000)), **body}
                d.setdefault("environments", []).append(env)
                save_data(d)
            return self.send_json(201, env)

        # POST /api/requests/:reqId/responses - Save response to request's history
        m = re.match(r"^/api/requests/([^/]+)/responses$", path)
        if m:
            req_id = m.group(1)
            body = self.read_json_body()
            with _lock:
                saved = add_request_response(req_id, body)
            return self.send_json(201, saved)

        # POST /api/collections/:id/requests
        m = re.match(r"^/api/collections/([^/]+)/requests$", path)
        if m:
            col_id = m.group(1)
            body = self.read_json_body()
            with _lock:
                d = load_data()
                col = next((c for c in d.get("collections", []) if c["id"] == col_id), None)
                if not col:
                    return self.send_json(404, {"error": "Collection not found"})
                req = {"id": str(int(time.time() * 1000)), **body,
                       "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
                col.setdefault("requests", []).append(req)
                save_data(d)
            return self.send_json(201, req)

        # POST /api/collections/:id/folders - Create folder in collection
        m = re.match(r"^/api/collections/([^/]+)/folders$", path)
        if m:
            col_id = m.group(1)
            body = self.read_json_body()
            with _lock:
                d = load_data()
                col = next((c for c in d.get("collections", []) if c["id"] == col_id), None)
                if not col:
                    return self.send_json(404, {"error": "Collection not found"})
                folder = {"id": str(int(time.time() * 1000)), "name": body.get("name", "New Folder"), "requests": []}
                col.setdefault("folders", []).append(folder)
                save_data(d)
            return self.send_json(201, folder)

        # POST /api/collections/:colId/folders/:folderId/requests - Add request to folder
        m = re.match(r"^/api/collections/([^/]+)/folders/([^/]+)/requests$", path)
        if m:
            col_id, folder_id = m.group(1), m.group(2)
            body = self.read_json_body()
            with _lock:
                d = load_data()
                col = next((c for c in d.get("collections", []) if c["id"] == col_id), None)
                if not col:
                    return self.send_json(404, {"error": "Collection not found"})
                folder = next((f for f in col.get("folders", []) if f["id"] == folder_id), None)
                if not folder:
                    return self.send_json(404, {"error": "Folder not found"})
                req = {"id": str(int(time.time() * 1000)), **body,
                       "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
                folder.setdefault("requests", []).append(req)
                save_data(d)
            return self.send_json(201, req)

        self.send_json(404, {"error": "Not found"})

    def do_PUT(self):
        path = self.path.split("?")[0]
        body = self.read_json_body()

        # PUT /api/collections/:id
        m = re.match(r"^/api/collections/([^/]+)$", path)
        if m:
            col_id = m.group(1)
            with _lock:
                d = load_data()
                for col in d.get("collections", []):
                    if col["id"] == col_id:
                        col.update(body)
                        save_data(d)
                        return self.send_json(200, col)
            return self.send_json(404, {"error": "Not found"})

        # PUT /api/collections/:colId/requests/:reqId
        m = re.match(r"^/api/collections/([^/]+)/requests/([^/]+)$", path)
        if m:
            col_id, req_id = m.group(1), m.group(2)
            with _lock:
                d = load_data()
                col = next((c for c in d.get("collections", []) if c["id"] == col_id), None)
                if not col:
                    return self.send_json(404, {"error": "Collection not found"})
                # Check root requests
                for req in col.get("requests", []):
                    if req["id"] == req_id:
                        req.update(body)
                        save_data(d)
                        return self.send_json(200, req)
                # Check folder requests
                for folder in col.get("folders", []):
                    for req in folder.get("requests", []):
                        if req["id"] == req_id:
                            req.update(body)
                            save_data(d)
                            return self.send_json(200, req)
            return self.send_json(404, {"error": "Request not found"})

        # PUT /api/collections/:colId/folders/:folderId - Rename folder
        m = re.match(r"^/api/collections/([^/]+)/folders/([^/]+)$", path)
        if m:
            col_id, folder_id = m.group(1), m.group(2)
            with _lock:
                d = load_data()
                col = next((c for c in d.get("collections", []) if c["id"] == col_id), None)
                if not col:
                    return self.send_json(404, {"error": "Collection not found"})
                for folder in col.get("folders", []):
                    if folder["id"] == folder_id:
                        folder.update(body)
                        save_data(d)
                        return self.send_json(200, folder)
            return self.send_json(404, {"error": "Folder not found"})

        # PUT /api/environments/:id
        m = re.match(r"^/api/environments/([^/]+)$", path)
        if m:
            env_id = m.group(1)
            with _lock:
                d = load_data()
                for env in d.get("environments", []):
                    if env["id"] == env_id:
                        env.update(body)
                        save_data(d)
                        return self.send_json(200, env)
            return self.send_json(404, {"error": "Not found"})

        self.send_json(404, {"error": "Not found"})

    def do_DELETE(self):
        path = self.path.split("?")[0]

        if path == "/api/history":
            with _lock:
                d = load_data()
                d["history"] = []
                save_data(d)
            return self.send_json(200, {"success": True})

        # DELETE /api/collections/:id
        m = re.match(r"^/api/collections/([^/]+)$", path)
        if m:
            col_id = m.group(1)
            with _lock:
                d = load_data()
                d["collections"] = [c for c in d.get("collections", []) if c["id"] != col_id]
                save_data(d)
            return self.send_json(200, {"success": True})

        # DELETE /api/collections/:colId/requests/:reqId
        m = re.match(r"^/api/collections/([^/]+)/requests/([^/]+)$", path)
        if m:
            col_id, req_id = m.group(1), m.group(2)
            with _lock:
                d = load_data()
                col = next((c for c in d.get("collections", []) if c["id"] == col_id), None)
                if col:
                    # Check root requests
                    col["requests"] = [r for r in col.get("requests", []) if r["id"] != req_id]
                    # Check folder requests
                    for folder in col.get("folders", []):
                        folder["requests"] = [r for r in folder.get("requests", []) if r["id"] != req_id]
                    save_data(d)
            return self.send_json(200, {"success": True})

        # DELETE /api/collections/:colId/folders/:folderId
        m = re.match(r"^/api/collections/([^/]+)/folders/([^/]+)$", path)
        if m:
            col_id, folder_id = m.group(1), m.group(2)
            with _lock:
                d = load_data()
                col = next((c for c in d.get("collections", []) if c["id"] == col_id), None)
                if col:
                    col["folders"] = [f for f in col.get("folders", []) if f["id"] != folder_id]
                    save_data(d)
            return self.send_json(200, {"success": True})

        # DELETE /api/environments/:id
        m = re.match(r"^/api/environments/([^/]+)$", path)
        if m:
            env_id = m.group(1)
            with _lock:
                d = load_data()
                d["environments"] = [e for e in d.get("environments", []) if e["id"] != env_id]
                save_data(d)
            return self.send_json(200, {"success": True})

        # DELETE /api/requests/:reqId/responses - Delete all response history for a request
        m = re.match(r"^/api/requests/([^/]+)/responses$", path)
        if m:
            req_id = m.group(1)
            with _lock:
                delete_request_responses(req_id)
            return self.send_json(200, {"success": True})

        # DELETE /api/requests/:reqId/responses/:respId - Delete specific response
        m = re.match(r"^/api/requests/([^/]+)/responses/([^/]+)$", path)
        if m:
            req_id, resp_id = m.group(1), m.group(2)
            with _lock:
                responses = load_responses()
                if req_id in responses:
                    responses[req_id] = [r for r in responses[req_id] if r.get("id") != resp_id]
                    save_responses(responses)
            return self.send_json(200, {"success": True})

        self.send_json(404, {"error": "Not found"})


# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────
if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), APIHandler)
    print(f"\n⚡ API Client running at http://localhost:{PORT}\n")
    print("   Press Ctrl+C to stop\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
        server.server_close()
