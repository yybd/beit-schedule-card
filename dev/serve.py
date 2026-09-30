"""Preview server for the card: http://localhost:8766

    python3 dev/serve.py

Serves the repo, so dev/card-preview.html can load dist/ and the synthetic fixtures (offline mode, a fake hass).

Live mode (?live=1) talks to a real Home Assistant named in dev.env.json (git-ignored): {"url": "...", "token": "..."}.
The page opens HA's WebSocket itself; REST calls go through /api/* here, which adds the token server-side, since the
browser cannot call HA's REST API cross-origin. The server listens on 127.0.0.1 only.
"""

import http.server
import json
import os
import socketserver
import urllib.error
import urllib.request

PORT = int(os.environ.get("PORT", "8766"))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_FILE = os.path.join(ROOT, "dev.env.json")


def env():
    try:
        with open(ENV_FILE) as f:
            e = json.load(f)
        return e["url"].rstrip("/"), e["token"]
    except (OSError, KeyError, ValueError):
        return None, None


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", "/dev/card-preview.html")
            self.end_headers()
        elif self.path == "/live.json":
            url, token = env()
            if not url:
                return self._json(404, {"message": "no dev.env.json"})
            self._json(200, {"ws": url.replace("http", "ws", 1) + "/api/websocket", "token": token})
        elif self.path.startswith("/api/"):
            self._proxy()
        elif os.path.basename(self.translate_path(self.path)) == "dev.env.json":
            self.send_error(404)  # the token stays on the server
        else:
            super().do_GET()

    def do_POST(self):
        self._proxy()

    def do_DELETE(self):
        self._proxy()

    def _proxy(self):
        url, token = env()
        if not url or not self.path.startswith("/api/"):
            return self._json(404, {"message": "no dev.env.json"})
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(url + self.path, data=body, method=self.command)
        req.add_header("Authorization", f"Bearer {token}")
        if body is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=20) as res:
                status, data = res.status, res.read()
        except urllib.error.HTTPError as err:
            status, data = err.code, err.read()
        except urllib.error.URLError as err:
            return self._json(502, {"message": str(err.reason)})
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print(f"preview at http://localhost:{PORT}", flush=True)
        httpd.serve_forever()
