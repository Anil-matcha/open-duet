"""Policy, DNS pinning, protocol transport and isolation launch regressions."""
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import threading
from types import SimpleNamespace

import pytest

from app.core import turn_egress as gate
from app.core import turn_sandbox as box
from app.core.config import settings


@pytest.fixture
def public_dns(monkeypatch):
    monkeypatch.setattr(gate, 'local_addresses', lambda: set())
    def resolve(addresses):
        monkeypatch.setattr(gate.socket, 'getaddrinfo', lambda *a, **kw: [
            (socket.AF_INET6 if ':' in address else socket.AF_INET, socket.SOCK_STREAM, 6, '', (address, 443))
            for address in addresses])
    return resolve


@pytest.mark.parametrize('address', [
    '127.0.0.1', '0.0.0.0', '10.1.2.3', '192.168.0.2', '172.16.0.2',
    '169.254.169.254', '100.100.100.200', '168.63.129.16', '192.0.2.4',
    '224.0.0.1', '240.0.0.1', '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '64:ff9b::a00:1', '64:ff9b:1::a00:1',
    '2002:7f00:1::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2',
])
def test_private_metadata_reserved_and_transition_destinations_refused(public_dns, address):
    public_dns([address])
    with pytest.raises(gate.Refused):
        gate.public_addresses('outside.example', 443)


def test_mixed_public_private_answer_is_wholly_refused(public_dns):
    public_dns(['93.184.216.34', '127.0.0.1'])
    with pytest.raises(gate.Refused):
        gate.public_addresses('rebind.example', 443)


def test_own_public_interface_is_refused(monkeypatch, public_dns):
    public_dns(['93.184.216.34'])
    monkeypatch.setattr(gate, 'local_addresses', lambda: {'93.184.216.34'})
    with pytest.raises(gate.Refused):
        gate.public_addresses('own.example', 443)


@pytest.mark.parametrize('host,port', [('example.com', 22), ('example.com', 8080), ('fe80::1%eth0', 443), ('', 80)])
def test_invalid_target_is_refused_before_dns(monkeypatch, host, port):
    monkeypatch.setattr(gate.socket, 'getaddrinfo', lambda *a, **kw: pytest.fail('must not resolve'))
    with pytest.raises(gate.Refused):
        gate.public_addresses(host, port)


def test_numeric_connect_uses_the_checked_answer_without_resolving_again(monkeypatch, public_dns):
    public_dns(['93.184.216.34'])
    calls = []
    upstream = SimpleNamespace(settimeout=lambda value: None, connect=lambda address: calls.append(address))
    monkeypatch.setattr(gate.socket, 'socket', lambda *a: upstream)
    assert gate.connect_public('public.example', 443) is upstream
    assert calls == [('93.184.216.34', 443)]


FORBIDDEN = b'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'


def receive_response(client, *, expected=None):
    response = bytearray()
    while expected is None or len(response) < len(expected):
        chunk = client.recv(65536)
        if not chunk:
            break
        response.extend(chunk)
    if expected is not None:
        assert bytes(response) == expected
    return bytes(response)


def exchange(request, monkeypatch, *, upstream=False, expected_response=None):
    """Real duplex socket transport, without making an internet connection."""
    client, worker = socket.socketpair()
    failures = []
    threads = []
    if upstream:
        outgoing, remote = socket.socketpair()
        monkeypatch.setattr(gate, 'connect_public', lambda host, port: outgoing)
        def echo():
            with remote:
                received = bytearray()
                while chunk := remote.recv(65536):
                    received.extend(chunk)
                remote.sendall(bytes(received))
        threads.append(threading.Thread(target=echo))
    def serve():
        try:
            with worker:
                gate.proxy_request(worker)
        except BaseException as exc:
            failures.append(exc)
    threads.append(threading.Thread(target=serve))
    for thread in threads:
        thread.start()
    with client:
        client.settimeout(5)
        client.sendall(request)
        client.shutdown(socket.SHUT_WR)
        response = receive_response(client, expected=expected_response)
    for thread in threads:
        thread.join(5)
        assert not thread.is_alive()
    assert not failures
    return bytes(response)


def test_connect_preserves_binary_and_initial_tunnel_bytes(monkeypatch):
    request = b'CONNECT public.example:443 HTTP/1.1\r\nHost: public.example\r\n\r\n\x00\xfftls'
    response = exchange(request, monkeypatch, upstream=True)
    assert response == b'HTTP/1.1 200 Connection Established\r\n\r\n\x00\xfftls'


def test_plain_http_rewrites_authority_and_strips_proxy_credentials(monkeypatch):
    request = (b'POST http://public.example/path?q=1 HTTP/1.1\r\nHost: 127.0.0.1\r\n'
               b'Proxy-Authorization: secret\r\nContent-Length: 4\r\n\r\nbody')
    response = exchange(request, monkeypatch, upstream=True)
    assert response.startswith(b'POST /path?q=1 HTTP/1.1\r\nHost: public.example:80\r\nConnection: close\r\n')
    assert b'secret' not in response and b'127.0.0.1' not in response
    assert response.endswith(b'\r\n\r\nbody')


@pytest.mark.parametrize('target', [b'http://127.0.0.1/', b'http://public.example:8080/', b'http://public.example@127.0.0.1/', b'/relative'])
def test_http_refusal_never_connects_to_private_or_invalid_target(monkeypatch, public_dns, target):
    public_dns(['127.0.0.1'])
    assert exchange(b'GET ' + target + b' HTTP/1.1\r\nHost: x\r\n\r\n', monkeypatch).startswith(b'HTTP/1.1 403')


def test_oversized_headers_refused(monkeypatch):
    monkeypatch.setattr(gate, 'connect_public', lambda *a: pytest.fail('must not connect'))
    # The bounded parser leaves unread request bytes. Linux may reset the
    # socket on close after delivering this complete Content-Length: 0 frame;
    # the response is complete without another recv waiting for EOF.
    assert exchange(b'GET http://x/ HTTP/1.1\r\nLarge: ' + b'x' * gate.HEADER_LIMIT + b'\r\n\r\n',
                    monkeypatch, expected_response=FORBIDDEN) == FORBIDDEN


def test_complete_refusal_does_not_require_eof():
    reads = iter([FORBIDDEN])
    def recv(_size):
        try:
            return next(reads)
        except StopIteration:
            raise ConnectionResetError('peer closed with unread request bytes')
    assert receive_response(SimpleNamespace(recv=recv), expected=FORBIDDEN) == FORBIDDEN


@pytest.mark.parametrize('received', [b'', b'HTTP/1.1 403', FORBIDDEN[:-1],
                                       FORBIDDEN.replace(b'403', b'502'), FORBIDDEN + b'extra'])
@pytest.mark.parametrize('reset', [False, True])
def test_incomplete_or_different_refusal_still_fails(received, reset):
    reads = iter([received])
    def recv(_size):
        try:
            return next(reads)
        except StopIteration:
            if reset:
                raise ConnectionResetError('peer reset')
            return b''
    with pytest.raises((AssertionError, ConnectionResetError)):
        receive_response(SimpleNamespace(recv=recv), expected=FORBIDDEN)


@pytest.fixture
def network_box(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, 'TURN_SANDBOX_ENABLED', True)
    monkeypatch.setattr(settings, 'TURN_SANDBOX_NETWORK_ENABLED', True)
    monkeypatch.setattr(settings, 'TURN_SANDBOX_READONLY_PATHS', '')
    monkeypatch.setattr(settings, 'TURN_SANDBOX_WRITABLE_PATHS', '')
    monkeypatch.setattr(settings, 'SQLITE_PATH', str(tmp_path / 'data' / 'app.db'))
    monkeypatch.setattr(box.sys, 'platform', 'linux')
    monkeypatch.setattr(box.profile, 'active', lambda: False)
    monkeypatch.setattr(box.shutil, 'which', lambda name: '/usr/bin/bwrap')
    workspace = tmp_path / 'workspace'
    workspace.mkdir()
    return workspace


@pytest.fixture
def real_network_box(monkeypatch, tmp_path):
    """Enable the real Linux sandbox without platform or executable fakes."""
    monkeypatch.setattr(settings, 'TURN_SANDBOX_ENABLED', True)
    monkeypatch.setattr(settings, 'TURN_SANDBOX_NETWORK_ENABLED', True)
    monkeypatch.setattr(settings, 'TURN_SANDBOX_READONLY_PATHS', '')
    monkeypatch.setattr(settings, 'TURN_SANDBOX_WRITABLE_PATHS', '')
    monkeypatch.setattr(settings, 'SQLITE_PATH', str(tmp_path / 'data' / 'app.db'))
    workspace = tmp_path / 'workspace'
    workspace.mkdir()
    return workspace


def test_network_setting_cannot_silently_run_without_filesystem_box(monkeypatch):
    monkeypatch.setattr(settings, 'TURN_SANDBOX_ENABLED', False)
    monkeypatch.setattr(settings, 'TURN_SANDBOX_NETWORK_ENABLED', True)
    with pytest.raises(box.SandboxUnavailable, match='requires'):
        box.command(['codex'], cwd='/', env={})
    with pytest.raises(box.SandboxUnavailable, match='requires'):
        box.self_check()


def test_network_plan_has_no_host_tcp_listener_or_bypass_environment(network_box):
    command = box.command(['codex', 'app-server'], cwd=network_box, env={'NO_PROXY': '*', 'ALL_PROXY': 'http://host:80'})
    assert command[:3] == [sys.executable, str(Path(gate.__file__).resolve()), 'supervise']
    assert '--unshare-net' in command
    index = command.index('__TURN_EGRESS_SOCKET__')
    assert command[index - 1:index + 2] == ['--ro-bind', '__TURN_EGRESS_SOCKET__', gate.SOCKET_PATH]
    assert command[-3:] == ['bridge', 'codex', 'app-server']
    for name in ('NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy'):
        index = command.index(name)
        assert command[index - 1] == '--unsetenv'


@pytest.mark.parametrize('network', ['net:[host]', '', 'pid:[other]'])
def test_self_check_refuses_shared_or_missing_network_namespace(monkeypatch, network_box, network):
    monkeypatch.setattr(box.os, 'readlink', lambda name: 'net:[host]' if name.endswith('/net') else 'pid:[host]')
    monkeypatch.setattr(box.subprocess, 'run', lambda *a, **kw: SimpleNamespace(returncode=0, stdout='pid:[new]\n' + network))
    with pytest.raises(box.SandboxUnavailable, match='network namespace'):
        box.self_check()


def test_supervisor_preserves_stdio_and_cleans_gate_socket(tmp_path):
    # This exercises real supervisor/gate/child lifetime on any UNIX host;
    # it does not claim to exercise bubblewrap or a network namespace.
    script = ('import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); '
              's.sendall(b"CONNECT 127.0.0.1:443 HTTP/1.1\\r\\n\\r\\n"); '
              'assert s.recv(4096).startswith(b"HTTP/1.1 403"); s.close(); '
              'print(sys.argv[1]); print(input())')
    result = subprocess.run([sys.executable, gate.__file__, 'supervise', sys.executable, '-c', script,
                             '__TURN_EGRESS_SOCKET__'], input='protocol preserved\n', text=True,
                            capture_output=True, timeout=10)
    assert result.returncode == 0, result.stderr
    socket_path, echoed = result.stdout.splitlines()
    assert echoed == 'protocol preserved'
    assert not Path(socket_path).exists()
    assert not Path(socket_path).parent.exists()


def test_bridge_refuses_missing_gate_before_engine(monkeypatch, tmp_path):
    monkeypatch.setattr(gate, 'SOCKET_PATH', str(tmp_path / 'missing.sock'))
    monkeypatch.setattr(gate.subprocess, 'Popen', lambda *a, **kw: pytest.fail('engine must not start'))
    with pytest.raises(OSError):
        gate.bridge(['engine'])


@pytest.mark.skipif(not sys.platform.startswith('linux') or not shutil.which('bwrap'), reason='requires real Linux bubblewrap')
def test_real_linux_network_box_blocks_host_loopback_and_gates_proxy(real_network_box):
    """Exercise the actual network namespace, bridge, supervisor and gate together."""
    assert box.self_check()['status'] == 'available'
    with socket.socket() as host_listener:
        host_listener.bind(('127.0.0.1', 0))
        host_listener.listen(1)
        host_listener.settimeout(0.2)
        host_port = host_listener.getsockname()[1]

        result_file = real_network_box / 'network-result'
        script = r'''import socket, sys
port = int(sys.argv[1])
result_file = sys.argv[2]
try:
    socket.create_connection(("127.0.0.1", port), timeout=1).close()
except OSError:
    pass
else:
    raise SystemExit("boxed process reached a host loopback listener directly")

with socket.create_connection(("127.0.0.1", 18764), timeout=2) as proxy:
    proxy.sendall(b"CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n")
    response = bytearray()
    while b"\r\n\r\n" not in response:
        chunk = proxy.recv(4096)
        if not chunk:
            break
        response.extend(chunk)
    if not response.startswith(b"HTTP/1.1 403 Forbidden"):
        raise SystemExit("private destination was not refused by the host gate: " + repr(bytes(response)))
with open(result_file, "w", encoding="utf-8") as result:
    result.write("host loopback blocked; private proxy destination refused")
print("host loopback blocked; private proxy destination refused")
'''
        args = box.command([sys.executable, '-c', script, str(host_port), str(result_file)], cwd=real_network_box,
                           env={'PATH': '/usr/bin:/bin'})
        scratch = Path('/tmp')
        before = set(scratch.glob('duet-egress-*'))
        result = subprocess.run(args, capture_output=True, text=True, timeout=15,
                                env={'PATH': '/usr/bin:/bin'})
        after = set(scratch.glob('duet-egress-*'))
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == 'host loopback blocked; private proxy destination refused'
        assert result_file.read_text(encoding='utf-8') == 'host loopback blocked; private proxy destination refused'
        assert after <= before
        with pytest.raises(TimeoutError):
            host_listener.accept()
