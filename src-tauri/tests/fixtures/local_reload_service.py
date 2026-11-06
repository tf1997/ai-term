"""Private loopback acceptance fixture; never reads application configuration."""
import http.server
import json
import os
from pathlib import Path
import signal
import sys


def config(path):
    value = json.loads(Path(path).read_text(encoding='utf-8'))
    if set(value) != {'response'} or value['response'] not in ('before', 'after'):
        raise ValueError('invalid fixture config')
    return value


if sys.argv[1] == '--check':
    config(sys.argv[2])
    print('CONFIG_OK')
else:
    config_path, status_path = sys.argv[1:]
    active = config(config_path)
    generation = 0

    def snapshot():
        Path(status_path).write_text(json.dumps(dict(pid=os.getpid(), generation=generation, **active)), encoding='utf-8')

    def reload_config(_signal, _frame):
        global active, generation
        active = config(config_path)
        generation += 1
        snapshot()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = f"HTTP 200 response={active['response']} generation={generation}\n".encode()
            self.send_response(200)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    signal.signal(signal.SIGHUP, reload_config)
    server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
    snapshot()
    print(server.server_port, flush=True)
    server.serve_forever()
