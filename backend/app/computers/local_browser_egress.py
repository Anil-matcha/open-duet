"""Egress gate for the in-sandbox browser.

Chromium started inside a hosted sandbox shares the app's network namespace, so
it could reach the app on localhost, the cloud metadata address and anything on
the private network. The browser is started with `--proxy-server=<address>`
pointing at this gate, and every connection goes through `Gate`:

- the gate resolves the host name itself and connects to the checked IP, never
  to the name again, so a DNS answer that changes between check and connect
  (rebinding) cannot reach a blocked address;
- loopback, link-local (including 169.254.169.254), private, multicast,
  reserved and unspecified addresses are refused, as are IPv4-mapped IPv6
  forms of those; `allow` lists networks or hosts that are let through anyway;
- a redirect to a blocked address is a new request through the proxy, so it is
  checked the same way.

`check_url(url)` is the pure pre-check for tool arguments: http(s) only, no
credentials, no blocked literal host. Names are checked by the gate.

API: `gate = Gate(allow=())`; `address = await gate.start()` returns
"127.0.0.1:<port>"; `await gate.stop()`. Standard library only.
"""

import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit

MAX_HEADER_BYTES = 64 * 1024
CONNECT_TIMEOUT = 15
IDLE_TIMEOUT = 120


class Blocked(Exception):
    pass


def _unmap(ip):
    mapped = getattr(ip, "ipv4_mapped", None)
    return mapped if mapped is not None else ip


def _networks(allow):
    out = []
    for item in allow:
        try:
            out.append(ipaddress.ip_network(item, strict=False))
        except ValueError:
            continue
    return out


def ip_blocked(ip, allow=()) -> bool:
    ip = _unmap(ipaddress.ip_address(ip))
    if any(ip in net for net in _networks(allow) if net.version == ip.version):
        return False
    return not ip.is_global or ip.is_multicast


def _literal(host: str):
    try:
        return ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return None


def host_blocked(host: str, allow=()) -> bool:
    """True for a literal blocked address or a name that is local by definition."""
    host = host.strip("[]").rstrip(".").lower()
    if not host:
        return True
    ip = _literal(host)
    if ip is not None:
        return ip_blocked(ip, allow)
    if host in {a for a in allow if isinstance(a, str)}:
        return False
    return host == "localhost" or host.endswith(".localhost") or host.endswith(".local") or host.endswith(".internal")


def check_url(url: str, allow=()) -> str | None:
    """Return a plain-language reason the URL is refused, or None when it passes."""
    try:
        parts = urlsplit(url)
        host = parts.hostname
        parts.port
    except ValueError:
        return "That address is not valid."
    if parts.scheme not in ("http", "https"):
        return "Only http and https addresses can be opened."
    if parts.username or parts.password:
        return "Addresses with a user name or password are not allowed."
    if not host or host_blocked(host, allow):
        return "That address is on this server or a private network and cannot be opened."
    return None


async def resolve(host: str, port: int):
    infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [info[4][0] for info in infos]


class Gate:
    def __init__(self, allow=(), resolver=resolve):
        self.allow = tuple(allow)
        self._resolver = resolver
        self._server = None
        self._tasks = set()

    async def start(self) -> str:
        self._server = await asyncio.start_server(self._client, "127.0.0.1", 0)
        return "127.0.0.1:%d" % self._server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
        for task in list(self._tasks):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)

    async def _open(self, host: str, port: int):
        """Connect to a checked address of `host`; raise Blocked when none is allowed."""
        if host_blocked(host, self.allow):
            raise Blocked(host)
        literal = _literal(host)
        try:
            addrs = [str(literal)] if literal else await self._resolver(host, port)
        except OSError:
            raise Blocked(host)
        ok = [a for a in addrs if not ip_blocked(a, self.allow)]
        # One blocked answer taints the name: a mixed answer is a rebinding sign.
        if not ok or len(ok) != len(addrs):
            raise Blocked(host)
        last = None
        for addr in ok:
            try:
                return await asyncio.wait_for(asyncio.open_connection(addr, port), CONNECT_TIMEOUT)
            except (OSError, asyncio.TimeoutError) as exc:
                last = exc
        raise OSError(str(last))

    async def _client(self, reader, writer):
        task = asyncio.current_task()
        self._tasks.add(task)
        try:
            await self._serve(reader, writer)
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
        finally:
            self._tasks.discard(task)
            writer.close()

    async def _reply(self, writer, status: str):
        writer.write(f"HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode())
        await writer.drain()

    async def _serve(self, reader, writer):
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), CONNECT_TIMEOUT)
        if len(head) > MAX_HEADER_BYTES:
            return await self._reply(writer, "431 Request Header Fields Too Large")
        line, _, rest = head.partition(b"\r\n")
        try:
            method, target, version = line.decode("latin-1").split(" ")
        except ValueError:
            return await self._reply(writer, "400 Bad Request")
        try:
            if method.upper() == "CONNECT":
                host, _, port = target.rpartition(":")
                upstream = await self._open(host, int(port))
                request = b""
            else:
                parts = urlsplit(target)
                if parts.scheme != "http" or not parts.hostname or parts.username or parts.password:
                    return await self._reply(writer, "400 Bad Request")
                host, port = parts.hostname, parts.port or 80
                upstream = await self._open(host, port)
                path = (parts.path or "/") + ("?" + parts.query if parts.query else "")
                request = f"{method} {path} {version}\r\n".encode("latin-1") + _drop_hop_headers(rest)
        except Blocked:
            return await self._reply(writer, "403 Forbidden")
        except (OSError, ValueError):
            return await self._reply(writer, "502 Bad Gateway")
        up_reader, up_writer = upstream
        try:
            if method.upper() == "CONNECT":
                writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                await writer.drain()
            else:
                up_writer.write(request)
                await up_writer.drain()
            await asyncio.gather(_pipe(reader, up_writer), _pipe(up_reader, writer))
        finally:
            up_writer.close()


def _drop_hop_headers(rest: bytes) -> bytes:
    """Keep the request headers but force one request per connection."""
    keep = []
    for raw in rest.split(b"\r\n"):
        name = raw.split(b":", 1)[0].strip().lower()
        if raw and name not in (b"proxy-connection", b"connection", b"keep-alive"):
            keep.append(raw)
    return b"\r\n".join(keep) + b"\r\nConnection: close\r\n\r\n"


async def _pipe(reader, writer):
    try:
        while True:
            data = await asyncio.wait_for(reader.read(65536), IDLE_TIMEOUT)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (OSError, asyncio.TimeoutError):
        pass
    finally:
        try:
            writer.close()
        except OSError:
            pass
