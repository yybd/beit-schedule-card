"""Preview server for the card: http://localhost:8766

    python3 dev/serve.py

Serves the repo, so dev/card-preview.html can load dist/ and the synthetic fixtures (offline mode, a fake hass).
"""

import http.server
import os
import socketserver

PORT = int(os.environ.get("PORT", "8766"))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", "/dev/card-preview.html")
            self.end_headers()
            return
        super().do_GET()


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print(f"preview at http://localhost:{PORT}", flush=True)
        httpd.serve_forever()
