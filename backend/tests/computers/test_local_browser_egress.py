"""Local browser egress gate: blocked address classes, rebinding, proxying."""
import asyncio

import pytest

from app.computers import local_browser_egress as egress
from app.computers.local_browser_egress import Gate, check_url, ip_blocked


@pytest.mark.parametrize("ip", [
    "127.0.0.1", "127.1.2.3", "::1", "169.254.169.254", "fe80::1", "10.0.0.5", "172.16.3.4",
    "192.168.1.1", "100.64.0.1", "224.0.0.1", "ff02::1", "0.0.0.0", "::", "fc00::1",
    "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:10.1.1.1",
])
def test_blocked_addresses(ip):
    assert ip_blocked(ip)


@pytest.mark.parametrize("ip", ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])
def test_public_addresses_pass(ip):
    assert not ip_blocked(ip)


def test_allowlist_lets_a_network_through():
    assert ip_blocked("10.1.2.3")
    assert not ip_blocked("10.1.2.3", allow=["10.1.0.0/16"])
    assert not ip_blocked("::ffff:10.1.2.3", allow=["10.1.0.0/16"])
    assert ip_blocked("10.2.2.3", allow=["10.1.0.0/16"])


@pytest.mark.parametrize("url", [
    "file:///etc/passwd", "ftp://example.com", "javascript:alert(1)", "http://user:pw@example.com/",
    "http://localhost:8080/", "http://app.localhost/", "http://127.0.0.1/", "http://[::1]/",
    "http://169.254.169.254/latest/meta-data", "http://[::ffff:127.0.0.1]/", "http://10.0.0.1/",
    "http://box.internal/", "http:///nohost", "http://example.com:99999/",
])
def test_check_url_refuses(url):
    assert check_url(url)


def test_check_url_passes_and_allowlist():
    assert check_url("https://example.com/a?b=1") is None
    assert check_url("http://8.8.8.8:8080/") is None
    assert check_url("http://127.0.0.1:3000/", allow=["127.0.0.1/32"]) is None


async def _request(address, payload: bytes) -> bytes:
    host, port = address.rsplit(":", 1)
    reader, writer = await asyncio.open_connection(host, int(port))
    writer.write(payload)
    await writer.drain()
    data = await asyncio.wait_for(reader.read(65536), 5)
    writer.close()
    return data


async def _origin():
    async def handle(reader, writer):
        await reader.readuntil(b"\r\n\r\n")
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi")
        await writer.drain()
        writer.close()
    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    return server, server.sockets[0].getsockname()[1]


async def test_connect_to_loopback_is_refused():
    origin, port = await _origin()
    gate = Gate()
    address = await gate.start()
    try:
        data = await _request(address, f"CONNECT 127.0.0.1:{port} HTTP/1.1\r\n\r\n".encode())
        assert data.startswith(b"HTTP/1.1 403")
        data = await _request(address, f"GET http://127.0.0.1:{port}/ HTTP/1.1\r\nHost: x\r\n\r\n".encode())
        assert data.startswith(b"HTTP/1.1 403")
        data = await _request(address, b"CONNECT 169.254.169.254:80 HTTP/1.1\r\n\r\n")
        assert data.startswith(b"HTTP/1.1 403")
    finally:
        await gate.stop()
        origin.close()


async def test_allowlisted_origin_is_proxied_over_get_and_connect():
    origin, port = await _origin()
    gate = Gate(allow=["127.0.0.1/32"])
    address = await gate.start()
    try:
        data = await _request(address, f"GET http://127.0.0.1:{port}/x HTTP/1.1\r\nHost: x\r\n\r\n".encode())
        assert data.startswith(b"HTTP/1.1 200") and data.endswith(b"hi")
        host, p = address.rsplit(":", 1)
        reader, writer = await asyncio.open_connection(host, int(p))
        writer.write(f"CONNECT 127.0.0.1:{port} HTTP/1.1\r\n\r\n".encode())
        assert (await reader.readuntil(b"\r\n\r\n")).startswith(b"HTTP/1.1 200")
        writer.write(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
        assert (await asyncio.wait_for(reader.read(65536), 5)).endswith(b"hi")
        writer.close()
    finally:
        await gate.stop()
        origin.close()


async def test_name_resolving_to_private_is_refused_and_mixed_answers_taint():
    answers = {"evil.test": ["10.0.0.9"], "mixed.test": ["8.8.8.8", "127.0.0.1"]}

    async def resolver(host, port):
        return answers[host]

    gate = Gate(resolver=resolver)
    address = await gate.start()
    try:
        for name in answers:
            data = await _request(address, f"CONNECT {name}:443 HTTP/1.1\r\n\r\n".encode())
            assert data.startswith(b"HTTP/1.1 403")
    finally:
        await gate.stop()


async def test_connects_to_the_checked_ip_not_the_name():
    seen = []
    origin, port = await _origin()

    async def resolver(host, p):
        seen.append(host)
        return ["127.0.0.1"]

    gate = Gate(allow=["127.0.0.1/32"], resolver=resolver)
    address = await gate.start()
    try:
        data = await _request(address, f"GET http://site.test:{port}/ HTTP/1.1\r\nHost: site.test\r\n\r\n".encode())
        assert data.endswith(b"hi")
        assert seen == ["site.test"]  # resolved exactly once, by the gate
    finally:
        await gate.stop()
        origin.close()


async def test_bad_requests_and_stop():
    gate = Gate()
    address = await gate.start()
    assert (await _request(address, b"garbage\r\n\r\n")).startswith(b"HTTP/1.1 400")
    assert (await _request(address, b"GET /relative HTTP/1.1\r\n\r\n")).startswith(b"HTTP/1.1 400")
    await gate.stop()
    host, port = address.rsplit(":", 1)
    with pytest.raises(OSError):
        await asyncio.open_connection(host, int(port))
