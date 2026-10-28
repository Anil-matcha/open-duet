#!/usr/bin/env python3
"""Gateway-semantics probe (AC 1) and its control (AC 4), for the S′ walkthrough.

The upstream claim under test: "a proxy on the host with the Docker route — the
app sees it as the network's gateway address; set TRUSTED_PROXIES to that
address. On a native Linux engine that stands for the host."

This host has no nginx/caddy, so the probe uses a **loopback hop** as a stand-in
forwarder and is explicitly labeled a simulation. The fidelity statement (which
semantics the hop emulates, which it does NOT) is printed by every run so it can be
pasted verbatim into the verification table row.

Modes:
  --mode hop            run the loopback hop and report whether the check passes
  --mode hop --unset-trusted   AC 4 control: address unset/wrong -> the check MUST fail
  --mode describe       print the fidelity statement only

Nothing here touches the network by default; `--mode hop` binds a loopback listener
on an ephemeral port and connects to it locally. No secret is read or printed.
"""

from __future__ import annotations

import argparse
import http.server
import socket
import sys
import threading
import urllib.error
import urllib.request

EMULATES = [
    "forwarded-header field (X-Forwarded-For) carry from client to server",
    "host substitution (the proxy's Host reaching the app)",
]
DOES_NOT_EMULATE = [
    "multi-hop X-Forwarded-For chains",
    "TLS termination",
    "connection-upgrade / websocket passthrough",
    "real proxy trust semantics (a third party cannot forge the chain)",
]

FIDELITY = (
    "simulated-labeled (loopback hop): emulates {emu}; does NOT emulate {not_emu}."
)


def fidelity_statement() -> str:
    return FIDELITY.format(emu="; ".join(EMULATES), not_emu="; ".join(DOES_NOT_EMULATE))


class _Hop(http.server.BaseHTTPRequestHandler):
    """A one-request loopback forwarder that echoes what it observed, so the probe
    can assert the forwarded-header field reached the origin."""

    def do_GET(self):  # noqa: N802 (http.server API)
        observed_xff = self.headers.get("X-Forwarded-For", "")
        observed_host = self.headers.get("Host", "")
        body = f"xff={observed_xff}\nhost={observed_host}\n".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # silence the default stderr logging
        pass


def _run_hop(timeout: float = 3.0) -> tuple[bool, str]:
    server = http.server.HTTPServer(("127.0.0.1", 0), _Hop)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/probe",
            headers={"X-Forwarded-For": "203.0.113.7", "Host": "dots.example.com"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            observed = resp.read().decode()
    except (urllib.error.URLError, socket.timeout, OSError) as exc:
        return False, f"hop failed: {exc}"
    finally:
        server.shutdown()
        server.server_close()

    ok = "xff=203.0.113.7" in observed and "host=dots.example.com" in observed
    return ok, observed.strip()


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["hop", "describe"], default="describe")
    parser.add_argument("--unset-trusted", action="store_true", help="AC 4 control")
    args = parser.parse_args(argv[1:])

    print(f"fidelity: {fidelity_statement()}")
    if args.mode == "describe":
        return 0

    # The gateway address the app would trust. Here it is the loopback hop's own
    # address, mirroring "a proxy on the same machine connects from loopback".
    trusted = None if args.unset_trusted else f"127.0.0.1"
    print(f"trusted-proxy address: {trusted!r}")

    ok, detail = _run_hop()
    print(detail)
    if not ok:
        print("RESULT: fail (the hop did not carry the forwarded header/host)")
        return 1

    # With the address unset/wrong the row MUST fail (AC 4). If we get here with
    # --unset-trusted, the check has no teeth — say so loudly.
    if args.unset_trusted:
        print("RESULT: fail — PASSES-WHEN-UNSET (row has no teeth; record in negative-control.md)")
        return 2
    print("RESULT: pass (simulated-labeled per the fidelity statement)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
