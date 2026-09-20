#!/usr/bin/env python3
"""Dependency-free static server for the playground UI.

Serves the ``app/`` directory (no build step) while forcing explicit MIME types
and ``Cache-Control: no-store``. A plain ``python -m http.server`` sends no
cache headers, so browsers heuristically cache ``styles.css`` and ES modules,
producing a mix of fresh HTML and stale assets (broken layout). This server
always hands out fresh bytes, so a normal reload is enough.

Usage:
    python scripts/serve_app.py [--port 8080] [--bind 127.0.0.1] [--dir PATH]
"""

from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEFAULT_DIR = Path(__file__).resolve().parent.parent / "app"

# Explicit types: don't rely on the OS mimetypes database, which may map
# .js/.mjs to text/plain (or nothing) and break ES modules.
MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
}


class NoCacheHandler(SimpleHTTPRequestHandler):
    """Static handler that never lets an asset go stale in the browser."""

    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, **MIME_TYPES}

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8080, help="port to listen on (default: 8080)")
    parser.add_argument("--bind", default="127.0.0.1", help="address to bind (default: 127.0.0.1)")
    parser.add_argument("--dir", type=Path, default=DEFAULT_DIR, help="directory to serve (default: app/)")
    args = parser.parse_args()

    directory = args.dir.resolve()
    if not directory.is_dir():
        parser.error(f"directory not found: {directory}")

    handler = partial(NoCacheHandler, directory=str(directory))
    server = ThreadingHTTPServer((args.bind, args.port), handler)

    print(f"Serving {directory} at http://{args.bind}:{args.port} (no-cache)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
