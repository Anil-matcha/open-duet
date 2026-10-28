"""A stand-in for desktop-image/od-browser: same environment variables and socket protocol, no Chromium.

It starts a child that sleeps (the stand-in for Chromium) so tests can check that the whole process
group is ended, and it writes what it was given to a file next to its socket."""
import json
import os
import socket
import subprocess
import sys
from pathlib import Path

sock = Path(os.environ["OD_BROWSER_SOCKET"])
keys = [k for k in os.environ if k.startswith("OD_BROWSER_")]
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
(sock.parent / "seen.json").write_text(json.dumps({"env": {k: os.environ[k] for k in keys}, "child": child.pid, "pgid": os.getpgrp(), "marker": os.environ.get("OPEN_DOTS_ENGINE_OF")}))
server = socket.socket(socket.AF_UNIX)
server.bind(str(sock))
server.listen(4)
while True:
    conn, _ = server.accept()
    with conn, conn.makefile("rwb") as f:
        request = json.loads(f.readline())
        if request["name"] == "browser_fail":
            reply = {"content": [{"type": "text", "text": "boom"}], "isError": True}
        else:
            reply = {"content": [{"type": "text", "text": "ok " + json.dumps(request, sort_keys=True)}]}
        f.write(json.dumps(reply).encode() + b"\n")
        f.flush()
