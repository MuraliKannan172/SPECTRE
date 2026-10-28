"""SSRF guard and fetch_page: every case runs offline.

The end-to-end cases drive the real httpx -> httpcore -> GuardedBackend stack
through a fake network backend that answers HTTP/1.1 from canned responses,
so DNS rebinding and redirect-to-private are checked where they happen: at
connect time, on the address the guard validated.
"""

from __future__ import annotations

import asyncio

import httpcore
import httpx
import pytest

from app.web.fetch import MAX_BYTES, FetchError, PageFetcher
from app.web.guard import (
    BlockedURL,
    GuardedBackend,
    GuardedTransport,
    check_url,
    guarded_client,
    is_public_address,
    pick_public_address,
)

PUBLIC = "93.184.215.14"
PUBLIC_V6 = "2606:4700::1111"


def run(coro):  # type: ignore[no-untyped-def]
    return asyncio.run(coro)


def resolver_for(table: dict[str, list[str]]):  # type: ignore[no-untyped-def]
    async def resolve(host: str, port: int) -> list[str]:
        if host not in table:
            raise OSError(f"no such host {host}")
        return table[host]

    return resolve


# -- URL form ------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    ["https://example.com/a?b=1", "http://example.com:80/", "HTTPS://Example.com:443/x", f"http://{PUBLIC}/"],
)
def test_public_urls_pass(url: str) -> None:
    check_url(url)


@pytest.mark.parametrize(
    ("url", "code"),
    [
        ("file:///etc/passwd", "scheme"),
        ("ftp://example.com/", "scheme"),
        ("javascript:alert(1)", "scheme"),
        ("gopher://example.com:70/", "scheme"),
        ("http://user:secret@example.com/", "credentials"),
        ("https://example.com:8443/", "port"),
        ("http://example.com:443/", "port"),
        ("http://example.com:22/", "port"),
        ("http://127.0.0.1/", "private_address"),
        ("http://169.254.169.254/latest/meta-data/", "private_address"),
        ("http://10.1.2.3/", "private_address"),
        ("http://192.168.1.1/", "private_address"),
        ("http://100.64.0.1/", "private_address"),
        ("http://0.0.0.0/", "private_address"),
        ("http://[::1]/", "private_address"),
        ("http://[fe80::1]/", "private_address"),
        ("http://[fc00::1]/", "private_address"),
        ("http://[::ffff:127.0.0.1]/", "private_address"),
        ("http://[::ffff:10.0.0.1]/", "private_address"),
        ("http://[2002:7f00:1::1]/", "private_address"),
        ("http://[64:ff9b::a00:1]/", "private_address"),
        ("http://localhost/", "private_address"),
        ("http://admin.localhost/", "private_address"),
        ("http:///nohost", "no_host"),
        ("", "bad_url"),
        ("http://[::1/", "bad_url"),
    ],
)
def test_blocked_urls(url: str, code: str) -> None:
    with pytest.raises(BlockedURL) as caught:
        check_url(url)
    assert caught.value.code == code


@pytest.mark.parametrize(
    ("address", "public"),
    [
        (PUBLIC, True),
        (PUBLIC_V6, True),
        ("::ffff:8.8.8.8", True),
        ("100.64.0.1", False),
        ("198.18.0.1", False),
        ("224.0.0.1", False),
        ("255.255.255.255", False),
        ("ff02::1", False),
        ("fe80::1%eth0", False),
        ("not-an-ip", False),
    ],
)
def test_public_address_rule(address: str, public: bool) -> None:
    assert is_public_address(address) is public


# -- resolve once, check every answer ------------------------------------------


def test_every_dns_answer_must_be_public() -> None:
    resolve = resolver_for(
        {
            "ok.example": [PUBLIC, PUBLIC_V6],
            "mixed.example": [PUBLIC, "10.0.0.5"],
            "inner.example": ["127.0.0.1"],
        }
    )
    assert run(pick_public_address("ok.example", 443, resolve)) == PUBLIC
    for host in ("mixed.example", "inner.example"):
        with pytest.raises(BlockedURL) as caught:
            run(pick_public_address(host, 443, resolve))
        assert caught.value.code == "private_address"
    with pytest.raises(BlockedURL) as caught:
        run(pick_public_address("missing.example", 443, resolve))
    assert caught.value.code == "dns"


def test_numeric_host_spellings_are_checked_after_resolution() -> None:
    # Many resolvers read "2130706433" and "0177.0.0.1" as 127.0.0.1.
    resolve = resolver_for({"2130706433": ["127.0.0.1"], "0177.0.0.1": ["127.0.0.1"]})
    for host in ("2130706433", "0177.0.0.1"):
        check_url(f"http://{host}/")  # not an IP literal to ipaddress...
        with pytest.raises(BlockedURL):  # ...so the connect-time check stops it
            run(pick_public_address(host, 80, resolve))


# -- connect-time pinning --------------------------------------------------------


class Canned(httpcore.AsyncNetworkStream):
    """Answers each HTTP/1.1 request with the response its route names."""

    def __init__(self, routes: dict[str, bytes]) -> None:
        self._routes = routes
        self._request = b""
        self._reply: bytes | None = None

    async def write(self, buffer: bytes, timeout: float | None = None) -> None:
        self._request += buffer
        if b"\r\n\r\n" in self._request and self._reply is None:
            path = self._request.split(b" ", 2)[1].decode()
            self._reply = self._routes.get(path, b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")

    async def read(self, max_bytes: int, timeout: float | None = None) -> bytes:
        reply, self._reply = self._reply or b"", b""
        return reply

    async def aclose(self) -> None:
        return None

    def get_extra_info(self, info: str) -> object:
        return None


class FakeNetwork(httpcore.AsyncNetworkBackend):
    def __init__(self, sites: dict[str, dict[str, bytes]]) -> None:
        self.sites = sites
        self.connected: list[tuple[str, int]] = []

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):  # type: ignore[no-untyped-def]
        self.connected.append((host, port))
        if host not in self.sites:
            raise httpcore.ConnectError(f"refused {host}")
        return Canned(self.sites[host])

    async def connect_unix_socket(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        raise httpcore.ConnectError("no unix sockets")

    async def sleep(self, seconds: float) -> None:
        return None


def response(status: str, headers: dict[str, str] | None = None, body: bytes = b"") -> bytes:
    lines = [f"HTTP/1.1 {status}", f"Content-Length: {len(body)}", "Connection: close"]
    lines += [f"{name}: {value}" for name, value in (headers or {}).items()]
    return ("\r\n".join(lines) + "\r\n\r\n").encode() + body


HTML = response(
    "200 OK",
    {"Content-Type": "text/html; charset=utf-8"},
    b"<html><head><title>Quake report</title></head><body><article><h1>Quake report</h1>"
    b"<p>A magnitude 6.1 earthquake struck offshore at dawn, the survey said in its bulletin. "
    b"No tsunami warning was issued and local officials reported minor damage only.</p>"
    b"<p>Aftershocks continued through the morning, the strongest of magnitude 4.8.</p>"
    b"</article></body></html>",
)


def test_backend_connects_to_the_address_it_checked() -> None:
    network = FakeNetwork({})
    backend = GuardedBackend(resolver_for({"site.example": [PUBLIC]}), network)
    with pytest.raises(httpcore.ConnectError):
        run(backend.connect_tcp("site.example", 443))
    assert network.connected == [(PUBLIC, 443)]
    with pytest.raises(BlockedURL):
        run(backend.connect_tcp("site.example", 8080))
    assert len(network.connected) == 1


def test_dns_rebinding_cannot_reach_a_private_address() -> None:
    answers = iter([[PUBLIC], ["127.0.0.1"]])

    async def rebinding(host: str, port: int) -> list[str]:
        return next(answers)

    network = FakeNetwork({PUBLIC: {"/robots.txt": response("404 Not Found"), "/page": HTML}})
    fetcher = PageFetcher(
        guarded_client(user_agent="test", timeout=5, transport=GuardedTransport(rebinding, network)),
        user_agent_token="test",
    )
    # robots.txt resolves to the public address; the page lookup then answers
    # 127.0.0.1 and is refused before any connection is opened to it.
    with pytest.raises(BlockedURL) as caught:
        run(fetcher.fetch("http://rebind.example/page", max_chars=1000))
    assert caught.value.code == "private_address"
    assert network.connected == [(PUBLIC, 80)]


def test_redirect_to_a_private_name_is_refused_at_connect() -> None:
    network = FakeNetwork(
        {
            PUBLIC: {
                "/robots.txt": response("404 Not Found"),
                "/go": response("302 Found", {"Location": "http://intranet.example/admin"}),
            }
        }
    )
    resolve = resolver_for({"news.example": [PUBLIC], "intranet.example": ["10.0.0.7"]})
    fetcher = PageFetcher(
        guarded_client(user_agent="test", timeout=5, transport=GuardedTransport(resolve, network)),
        user_agent_token="test",
    )
    with pytest.raises(BlockedURL) as caught:
        run(fetcher.fetch("http://news.example/go", max_chars=1000))
    assert caught.value.code == "private_address"
    assert all(host == PUBLIC for host, _ in network.connected)


def test_the_guarded_stack_reads_a_public_page() -> None:
    network = FakeNetwork({PUBLIC: {"/robots.txt": response("404 Not Found"), "/page": HTML}})
    fetcher = PageFetcher(
        guarded_client(
            user_agent="test",
            timeout=5,
            transport=GuardedTransport(resolver_for({"news.example": [PUBLIC]}), network),
        ),
        user_agent_token="test",
    )
    page = run(fetcher.fetch("http://news.example/page", max_chars=60))
    assert "magnitude 6.1" in page.text
    assert page.truncated and len(page.text) == 60


# -- redirects, robots, content rules (mock transport) ---------------------------


def mock_fetcher(handler) -> PageFetcher:  # type: ignore[no-untyped-def]
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)
    return PageFetcher(client, user_agent_token="spectre")


def routes(table: dict[str, httpx.Response]):  # type: ignore[no-untyped-def]
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/robots.txt" and str(request.url) not in table:
            return httpx.Response(404)
        return table.get(str(request.url), httpx.Response(404))

    return handler


@pytest.mark.parametrize(
    ("location", "code"),
    [
        ("http://127.0.0.1/admin", "private_address"),
        ("http://[::ffff:169.254.169.254]/", "private_address"),
        ("https://news.example:8443/x", "port"),
        ("file:///etc/passwd", "scheme"),
    ],
)
def test_each_redirect_hop_is_checked(location: str, code: str) -> None:
    fetcher = mock_fetcher(
        routes({"https://news.example/a": httpx.Response(302, headers={"Location": location})})
    )
    with pytest.raises(BlockedURL) as caught:
        run(fetcher.fetch("https://news.example/a", max_chars=1000))
    assert caught.value.code == code


def test_at_most_three_redirects() -> None:
    table = {
        f"https://news.example/{i}": httpx.Response(302, headers={"Location": f"/{i + 1}"}) for i in range(5)
    }
    with pytest.raises(FetchError) as caught:
        run(mock_fetcher(routes(table)).fetch("https://news.example/0", max_chars=1000))
    assert caught.value.code == "too_many_redirects"


def test_robots_disallow_is_honoured() -> None:
    table = {
        "https://news.example/robots.txt": httpx.Response(200, text="User-agent: *\nDisallow: /private\n"),
        "https://news.example/private/x": httpx.Response(
            200, text="secret", headers={"Content-Type": "text/plain"}
        ),
    }
    with pytest.raises(FetchError) as caught:
        run(mock_fetcher(routes(table)).fetch("https://news.example/private/x", max_chars=1000))
    assert caught.value.code == "robots_disallowed"


def test_only_text_is_read_and_size_is_capped() -> None:
    table = {
        "https://news.example/pic": httpx.Response(
            200, content=b"\x89PNG", headers={"Content-Type": "image/png"}
        ),
        "https://news.example/huge": httpx.Response(
            200, content=b"a" * (MAX_BYTES + 1), headers={"Content-Type": "text/plain"}
        ),
        "https://news.example/gone": httpx.Response(410),
    }
    fetcher = mock_fetcher(routes(table))
    for path, code in (("pic", "not_text"), ("huge", "too_large"), ("gone", "http_status")):
        with pytest.raises(FetchError) as caught:
            run(fetcher.fetch(f"https://news.example/{path}", max_chars=1000))
        assert caught.value.code == code
