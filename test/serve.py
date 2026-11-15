import functools
import http.server
import mimetypes
import os

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/manifest+json", ".webmanifest")

root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
os.chdir(root)
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
http.server.ThreadingHTTPServer(("127.0.0.1", 8765), handler).serve_forever()
