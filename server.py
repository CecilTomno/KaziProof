"""Local-only development server for the KaziProof field-work demo."""

from __future__ import annotations

import json
import mimetypes
import sqlite3
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from repository import apply_sync_event, create_job, initialize_database, list_jobs, list_workers


ROOT = Path(__file__).resolve().parent
APP_DIR = ROOT / "app"
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "demo.sqlite3"
TENANT_ID = "demo-cleaning-co"
HOST = "127.0.0.1"
PORT = 4173
MAX_REQUEST_BYTES = 2_500_000


def open_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "KaziProofDemo/0.2"

    def log_message(self, format: str, *args: object) -> None:
        # Keep request bodies and customer-like demo data out of terminal logs.
        return

    def send_json(self, status: int, payload: object) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict:
        raw_length = self.headers.get("Content-Length", "0")
        try:
            length = int(raw_length)
        except ValueError:
            raise ValueError("content_length_invalid")
        if length < 0 or length > MAX_REQUEST_BYTES:
            raise ValueError("request_too_large")
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ValueError("json_invalid")
        if not isinstance(payload, dict):
            raise ValueError("json_object_required")
        return payload

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/health":
            self.send_json(200, {"ok": True, "mode": "local-demo"})
            return
        if path == "/api/bootstrap":
            connection = open_connection()
            try:
                tenant = connection.execute(
                    "SELECT id, name FROM tenants WHERE id = ?", (TENANT_ID,)
                ).fetchone()
                self.send_json(200, {
                    "tenant": dict(tenant) if tenant else None,
                    "workers": list_workers(connection, TENANT_ID),
                    "jobs": list_jobs(connection, TENANT_ID),
                    "server_time": datetime.now(timezone.utc).isoformat(),
                })
            finally:
                connection.close()
            return
        self.serve_static(path)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            payload = self.read_json()
            if path == "/api/jobs":
                connection = open_connection()
                try:
                    job = create_job(connection, TENANT_ID, payload)
                finally:
                    connection.close()
                self.send_json(201, {"job": job})
                return
            if path == "/api/sync":
                events = payload.get("events")
                if not isinstance(events, list) or len(events) > 20:
                    raise ValueError("events_invalid")
                connection = open_connection()
                results = []
                try:
                    for event in events:
                        try:
                            results.append({"ok": True, **apply_sync_event(connection, event)})
                        except ValueError as error:
                            results.append({
                                "ok": False,
                                "mutation_id": event.get("mutation_id") if isinstance(event, dict) else None,
                                "error": str(error),
                            })
                finally:
                    connection.close()
                self.send_json(200, {"results": results})
                return
            self.send_json(404, {"error": "not_found"})
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception:
            self.send_json(500, {"error": "server_error"})

    def serve_static(self, url_path: str) -> None:
        relative = url_path.lstrip("/") or "index.html"
        target = (APP_DIR / relative).resolve()
        if not target.is_relative_to(APP_DIR.resolve()) or not target.is_file():
            self.send_error(404)
            return
        try:
            body = target.read_bytes()
        except OSError:
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if target.suffix == ".webmanifest":
            content_type = "application/manifest+json"
        self.send_response(200)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8" if content_type.startswith("text/") or content_type in ("application/javascript", "application/manifest+json") else content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache" if target.name == "sw.js" else "public, max-age=300")
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    connection = open_connection()
    try:
        initialize_database(connection, seed_demo=True)
    finally:
        connection.close()
    server = ThreadingHTTPServer((HOST, PORT), RequestHandler)
    print(f"KaziProof local demo: http://{HOST}:{PORT}")
    print("Local demo only: no login, do not enter real customer or employee data.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping KaziProof local demo.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
