"""SSRF guard: the model may only reach public http(s) hosts on ports 80 and 443.

Two layers, both required:

* `check_url` rejects a URL before any request: wrong scheme, credentials,
  a non-default port, or a host that is a non-public IP literal.
* `GuardedBackend` is httpcore's network backend. It resolves the host once
  per connection, refuses the connection if *any* answer is non-public, and
  then connects to the address it checked. TLS still uses the hostname for
  SNI and certificate checks (httpcore passes the URL host to `start_tls`),
  so pinning the address does not weaken HTTPS. A DNS-rebinding server
  cannot swap in a private address between the check and the connect,
  because there is no second lookup.

Redirects are followed by the caller one hop at a time, and every hop goes
through both layers again.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
import ssl
from collections.abc import Awaitable, Callable, Iterable
from urllib.parse import SplitResult, urlsplit

import certifi
import httpcore
import httpx

DEFAULT_PORTS = {"http": 80, "https": 443}
MAX_URL_LENGTH = 2048

# 6to4, Teredo and NAT64 embed an IPv4 address the IPv6 checks cannot see.
_TUNNELS = tuple(
    ipaddress.ip_network(net) for net in ("2002::/16", "2001::/32", "64:ff9b::/96", "64:ff9b:1::/48")
)

Resolver = Callable[[str, int], Awaitable[list[str]]]


class BlockedURL(ValueError):
    """The URL or its address is not one the model may reach."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


def is_public_address(address: str) -> bool:
    """True only for globally routable unicast addresses."""
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return is_public_address(str(ip.ipv4_mapped))
        if any(ip in net for net in _TUNNELS):
            return False
    return ip.is_global and not ip.is_multicast


def check_url(url: str) -> SplitResult:
    """Validate a URL's form. Raises BlockedURL; returns the parsed URL."""
    if not isinstance(url, str) or not url or len(url) > MAX_URL_LENGTH:
        raise BlockedURL("bad_url")
    try:
        parts = urlsplit(url.strip())
        port = parts.port
    except ValueError as error:
        raise BlockedURL("bad_url", str(error)) from error
    scheme = parts.scheme.lower()
    if scheme not in DEFAULT_PORTS:
        raise BlockedURL("scheme", scheme or "none")
    if parts.username is not None or parts.password is not None:
        raise BlockedURL("credentials")
    host = (parts.hostname or "").rstrip(".")
    if not host:
        raise BlockedURL("no_host")
    if port is not None and port != DEFAULT_PORTS[scheme]:
        raise BlockedURL("port", str(port))
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if host.lower() in {"localhost", "localhost.localdomain"} or host.lower().endswith(".localhost"):
            raise BlockedURL("private_address", host) from None
        return parts
    if not is_public_address(host):
        raise BlockedURL("private_address", host)
    return parts


async def system_resolver(host: str, port: int) -> list[str]:
    """Every address the system resolver returns for host:port."""
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [str(info[4][0]) for info in infos]


async def pick_public_address(host: str, port: int, resolver: Resolver) -> str:
    """Resolve once; refuse unless every answer is public; return the first."""
    try:
        ipaddress.ip_address(host)
        answers: Iterable[str] = [host]
    except ValueError:
        try:
            answers = await resolver(host, port)
        except OSError as error:
            raise BlockedURL("dns", host) from error
    answers = list(dict.fromkeys(answers))
    if not answers:
        raise BlockedURL("dns", host)
    for address in answers:
        if not is_public_address(address):
            raise BlockedURL("private_address", f"{host} -> {address}")
    return answers[0]


class GuardedBackend(httpcore.AsyncNetworkBackend):
    """Connects only to the public address it resolved and checked."""

    def __init__(
        self,
        resolver: Resolver = system_resolver,
        inner: httpcore.AsyncNetworkBackend | None = None,
    ) -> None:
        self._resolver = resolver
        self._inner = inner or httpcore.AnyIOBackend()

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[httpcore.SOCKET_OPTION] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        if port not in DEFAULT_PORTS.values():
            raise BlockedURL("port", str(port))
        address = await pick_public_address(host, port, self._resolver)
        return await self._inner.connect_tcp(
            address,
            port,
            timeout=timeout,
            local_address=local_address,
            socket_options=socket_options,
        )

    async def connect_unix_socket(self, *args: object, **kwargs: object) -> httpcore.AsyncNetworkStream:
        raise BlockedURL("unix_socket")

    async def sleep(self, seconds: float) -> None:
        await self._inner.sleep(seconds)


class GuardedTransport(httpx.AsyncHTTPTransport):
    """httpx transport whose every connection goes through GuardedBackend."""

    def __init__(
        self,
        resolver: Resolver = system_resolver,
        network_backend: httpcore.AsyncNetworkBackend | None = None,
    ) -> None:
        super().__init__(retries=0)
        self._pool = httpcore.AsyncConnectionPool(
            ssl_context=ssl.create_default_context(cafile=certifi.where()),
            max_connections=8,
            max_keepalive_connections=0,
            http1=True,
            http2=False,
            retries=0,
            network_backend=GuardedBackend(resolver, network_backend),
        )


def guarded_client(
    *,
    user_agent: str,
    timeout: float,
    transport: httpx.AsyncBaseTransport | None = None,
) -> httpx.AsyncClient:
    """A client that never follows redirects itself and ignores proxy env vars
    (a proxy would make the proxy, not the target, the address checked)."""
    return httpx.AsyncClient(
        transport=transport or GuardedTransport(),
        follow_redirects=False,
        trust_env=False,
        timeout=httpx.Timeout(timeout),
        headers={"User-Agent": user_agent},
    )
