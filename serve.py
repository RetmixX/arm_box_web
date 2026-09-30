#!/usr/bin/env python3
"""
Сервер пульта ARM·BOX без зависимостей (только стандартная библиотека Python 3.8+).

Раздаёт index.html и assets/, а запросы /api/* и WebSocket /ws проксирует
на backend (FastAPI из репозитория arm_box). Это решает проблему CORS:
браузер видит всё на одном адресе.

Запуск:
    python serve.py                                   # backend на http://127.0.0.1:8000
    python serve.py --backend 192.168.0.10:8000 --port 8080
Затем открыть http://localhost:8080

IP и порт backend можно менять прямо из пульта (Настройки → IP и порт):
пульт вызывает служебный метод GET/POST /__backend этого сервера.
"""
import argparse
import http.client
import os
import select
import socket
import json
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ROOT = os.path.dirname(os.path.abspath(__file__))
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
       "trailers", "transfer-encoding", "upgrade", "host", "content-length"}


BACKEND = {"host": "127.0.0.1", "port": 8000}
_lock = threading.Lock()


def backend():
    with _lock:
        return BACKEND["host"], BACKEND["port"]


def make_handler():
    class Handler(SimpleHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def __init__(self, *a, **kw):
            super().__init__(*a, directory=ROOT, **kw)

        def log_message(self, fmt, *args):
            if self.path.startswith(("/api", "/ws")):
                sys.stderr.write("%s  %s\n" % (self.log_date_time_string(), fmt % args))

        def end_headers(self):
            if not self.path.startswith(("/api", "/ws")):
                self.send_header("Cache-Control", "no-cache")
            super().end_headers()

        # ---------------- маршрутизация ----------------
        def do_GET(self):
            if self.path == "/__backend":
                return self.backend_info()
            if self.path == "/ws" or self.path.startswith("/ws?"):
                return self.tunnel_ws()
            if self.path.startswith("/api/"):
                return self.proxy()
            return super().do_GET()

        def do_POST(self):
            if self.path == "/__backend":
                return self.backend_set()
            return self.proxy() if self.path.startswith("/api/") else self.send_error(405)

        do_PUT = do_PATCH = do_DELETE = do_POST

        def do_OPTIONS(self):
            return self.proxy() if self.path.startswith("/api/") else self.send_error(405)

        # ---------------- адрес backend (IP и порт) ----------------
        def send_json(self, code, obj):
            data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def backend_info(self):
            host, port = backend()
            self.send_json(200, {"proxy": "serve.py", "host": host, "port": port, "editable": True})

        def backend_set(self):
            try:
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                host = str(body.get("host", "")).strip()
                port = int(body.get("port"))
                if not host or not (0 < port < 65536) or any(c in host for c in "/ @?#"):
                    raise ValueError
            except (ValueError, TypeError):
                return self.send_json(400, {"detail": "нужны host (IP или имя) и port 1–65535"})
            with _lock:
                BACKEND.update(host=host, port=port)
            sys.stderr.write("backend -> http://%s:%d\n" % (host, port))
            self.backend_info()

        # ---------------- HTTP-прокси ----------------
        def proxy(self):
            backend_host, backend_port = backend()
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else None
            headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
            try:
                # POST /pos/set отвечает только после завершения движения
                conn = http.client.HTTPConnection(backend_host, backend_port, timeout=120)
                conn.request(self.command, self.path, body=body, headers=headers)
                res = conn.getresponse()
                data = res.read()
            except OSError as e:
                msg = ('{"detail":"backend %s:%s недоступен: %s"}' % (backend_host, backend_port, e)).encode()
                self.send_response(502)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)
                return
            self.send_response(res.status, res.reason)
            for k, v in res.getheaders():
                if k.lower() not in HOP:
                    self.send_header(k, v)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            conn.close()

        # ---------------- WebSocket-туннель ----------------
        def tunnel_ws(self):
            backend_host, backend_port = backend()
            try:
                up = socket.create_connection((backend_host, backend_port), timeout=10)
            except OSError:
                self.send_error(502, "Backend unavailable")
                return
            up.settimeout(None)
            lines = ["%s %s %s" % (self.command, self.path, self.request_version)]
            for k, v in self.headers.items():
                if k.lower() == "host":
                    v = "%s:%s" % (backend_host, backend_port)
                lines.append("%s: %s" % (k, v))
            up.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
            client = self.connection
            socks = [client, up]
            try:
                while True:
                    ready, _, _ = select.select(socks, [], [], 3600)
                    if not ready:
                        break
                    for s in ready:
                        data = s.recv(65536)
                        if not data:
                            return
                        (up if s is client else client).sendall(data)
            except OSError:
                pass
            finally:
                up.close()
                self.close_connection = True

    return Handler


def main():
    ap = argparse.ArgumentParser(description="Пульт ARM·BOX: статика + прокси на backend")
    ap.add_argument("--backend", default=os.environ.get("BACKEND_URL", "http://127.0.0.1:8000"),
                    help="IP:порт backend (по умолчанию 127.0.0.1:8000); можно поменять из пульта")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8080)))
    args = ap.parse_args()

    u = urlsplit(args.backend if "://" in args.backend else "http://" + args.backend)
    host, port = u.hostname or "127.0.0.1", u.port or 8000
    BACKEND.update(host=host, port=port)
    httpd = ThreadingHTTPServer((args.host, args.port), make_handler())
    httpd.daemon_threads = True
    print("ARM·BOX: http://localhost:%d   (backend: http://%s:%d)" % (args.port, host, port))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
