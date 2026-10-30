"""SPECTRE intel service: FastAPI app factory and entry point.

Start it with scripts/spectre.ps1, which runs uvicorn on 127.0.0.1:8100 with
this module's create_default_app as a factory.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import secrets
import time
from collections.abc import AsyncIterator, Mapping
from pathlib import Path
from typing import Any

import httpx
import httpx2
import keyring
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse
from keyring.backend import KeyringBackend

from .api.chat import ChatGate
from .api.chat import router as chat_router
from .api.providers import router as providers_router
from .api.routes import router
from .api.voice import router as voice_router
from .chat.agent import Agent
from .chat.providers.catalog import api_factories
from .chat.providers.keys import KeyStore
from .chat.providers.registry import DEFAULT_PATH as PROVIDERS_FILE
from .chat.providers.registry import Factory, ProviderConfigError, ProviderSet, default_providers
from .chat.providers.sdk import TIMEOUT as SDK_TIMEOUT
from .chat.tools import ToolRegistry
from .config import BRAND_NAME, DEFAULT_DB, DEFAULT_LOGS, Settings, load_settings
from .geo.gazetteer import Gazetteer
from .geo.geoparse import GeoParser
from .hub import EventHub
from .ingest.feeds import load_feed_config
from .ingest.pipeline import Pipeline
from .ingest.scheduler import Scheduler
from .legacy import migrate_defaults
from .redact import install_log_redaction, redact
from .store.chat import ChatStore
from .store.news import NewsStore
from .store.providers import ProviderStore
from .voice.service import VoiceService
from .web.fetch import TIMEOUT_SECONDS as FETCH_TIMEOUT
from .web.fetch import PageFetcher
from .web.guard import guarded_client
from .web.search import SearchService, make_search_service

log = logging.getLogger("spectre.intel")


def _load_providers(
    *,
    path: Path,
    ollama_http: httpx.AsyncClient,
    ollama_host: str,
    keys: KeyStore,
    store: ProviderStore,
    factories: Mapping[str, Factory] | None,
) -> tuple[ProviderSet | None, str | None]:
    """The providers, or None and why chat is unavailable. A bad provider file
    disables chat only; news, events and voice keep running."""
    try:
        providers = default_providers(
            ollama_http=ollama_http,
            ollama_host=ollama_host,
            path=path,
            key_for=keys.get,
            factories=factories,
        )
        for spec_id in providers.specs:
            saved = store.settings(spec_id).base_url
            if spec_id != "ollama" and saved:
                providers.rebuild(spec_id, saved)
    except (OSError, ValueError, ProviderConfigError) as error:
        return None, f"{path.name} unreadable ({type(error).__name__}): {error}"
    for spec in providers.specs.values():
        keys.status(spec)  # registers keys found in the environment or .env with the redactor
    if providers.get("ollama") is None:
        return providers, f"{path.name} has no ollama entry"
    return providers, None


def create_app(
    settings: Settings | None = None,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    geoparser: GeoParser | None = None,
    start_scheduler: bool = True,
    ollama_transport: httpx.AsyncBaseTransport | None = None,
    fetch_transport: httpx.AsyncBaseTransport | None = None,
    search: SearchService | None = None,
    tool_registry: ToolRegistry | None = None,
    voice: VoiceService | None = None,
    providers_file: Path = PROVIDERS_FILE,
    environ: Mapping[str, str] | None = None,
    keyring_backend: KeyringBackend | None = None,
    provider_factories: Mapping[str, Factory] | None = None,
) -> FastAPI:
    settings = settings or load_settings()
    # Keys set in the environment count only as they were at start-up (ADR-002 D5).
    boot_env = dict(os.environ if environ is None else environ)
    install_log_redaction()  # every log record, from every logger, before anything runs

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # SPECTRE: carry the pre-rename database and logs over, once (copies only).
        migrate_defaults(
            db_path=settings.db_path,
            default_db=DEFAULT_DB,
            logs_dir=settings.logs_dir,
            default_logs=DEFAULT_LOGS,
        )
        config = load_feed_config(settings.feeds_default, settings.feeds_local)
        store = NewsStore(str(settings.db_path))
        store.sync_feeds(config.all_defs())
        parser = geoparser or GeoParser(Gazetteer.load())
        await asyncio.to_thread(lambda: parser.nlp)  # load spaCy once, off the event loop
        pipeline = Pipeline(store, parser)
        warmed = await asyncio.to_thread(pipeline.warm, int(time.time()))
        client = httpx.AsyncClient(
            transport=transport,
            follow_redirects=True,
            max_redirects=5,
            timeout=httpx.Timeout(settings.fetch_timeout_seconds),
            headers={"User-Agent": settings.user_agent},
        )
        hub = EventHub()
        scheduler = Scheduler(settings, store, pipeline, hub, config, client)
        app.state.settings = settings
        app.state.store = store
        app.state.hub = hub
        app.state.geoparser = parser
        app.state.scheduler = scheduler
        app.state.started_at = int(time.time())
        chats = ChatStore(str(settings.db_path), settings.logs_dir)
        ollama_http = httpx.AsyncClient(transport=ollama_transport, trust_env=False)
        fetch_http = guarded_client(
            user_agent=settings.user_agent, timeout=FETCH_TIMEOUT, transport=fetch_transport
        )
        search_service = search or make_search_service(
            settings.search_provider,
            searxng_url=settings.searxng_url,
            brave_key=settings.brave_api_key,
            tavily_key=settings.tavily_api_key,
            client=client,
        )
        app.state.chats = chats
        app.state.search = search_service
        app.state.chat_gate = ChatGate(settings.chat_turns_per_minute)
        app.state.chat_problem = None
        registry = tool_registry
        if registry is None:
            try:
                registry = ToolRegistry.from_artifact()
            except (OSError, ValueError) as error:
                app.state.chat_problem = (
                    f"tool artifact unreadable ({type(error).__name__}): run npm run tools:export"
                )
        keys = KeyStore(
            boot_env=boot_env,
            env_file=settings.env_file,
            backend=keyring_backend if keyring_backend is not None else keyring.get_keyring(),
        )
        provider_store = ProviderStore(str(settings.db_path))
        # One client for every API provider; no redirects, so a key never follows one.
        sdk_http = httpx2.AsyncClient(timeout=SDK_TIMEOUT, follow_redirects=False)
        factories = {
            **api_factories(
                sdk_http,
                workspace_for=lambda pid: provider_store.settings(pid).workspace_id,
                chat_models_for=lambda pid: frozenset(provider_store.settings(pid).chat_completions_models),
            ),
            **(provider_factories or {}),
        }
        providers, problem = _load_providers(
            path=providers_file,
            ollama_http=ollama_http,
            ollama_host=settings.ollama_host,
            keys=keys,
            store=provider_store,
            factories=factories,
        )
        app.state.chat_problem = app.state.chat_problem or problem
        app.state.keys = keys
        app.state.provider_store = provider_store
        app.state.providers = providers
        app.state.session_token = secrets.token_urlsafe(32)
        ollama = providers.get("ollama") if providers else None
        app.state.agent = (
            Agent(
                settings=settings,
                ollama=ollama.client,
                news=store,
                chats=chats,
                search=search_service,
                fetcher=PageFetcher(fetch_http, user_agent_token=settings.user_agent.split("/", 1)[0]),
                registry=registry,
                open_only=lambda: not settings.noncommercial_enabled(),
                provider=ollama,
                local_only=lambda: provider_store.policy().local_only,
                consented=provider_store.consented,
                providers=lambda pid: providers.get(pid) if providers else None,
                known_tools=provider_store.known_tools,
                remember_tools=provider_store.remember_tools,
            )
            if registry is not None and ollama is not None
            else None
        )
        voice_service = voice or VoiceService(settings)
        app.state.voice = voice_service
        # Loads in the background; requests get 503 voice_loading until it is ready.
        voice_task = asyncio.create_task(voice_service.load()) if voice_service.state == "idle" else None
        task = asyncio.create_task(scheduler.run()) if start_scheduler else None
        log.info(
            "intel ready: %d sources, %d recent stories indexed, poll %ds",
            len(config.all_defs()),
            warmed,
            settings.poll_seconds,
        )
        try:
            yield
        finally:
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            if voice_task is not None and not voice_task.done():
                voice_task.cancel()  # the loader thread finishes on its own; nothing waits on it
            await scheduler.drain()
            await client.aclose()
            await ollama_http.aclose()
            await sdk_http.aclose()
            await fetch_http.aclose()
            chats.close()
            provider_store.close()
            store.close()

    app = FastAPI(
        title=f"{BRAND_NAME} intel",
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/api/intel/docs",
        openapi_url="/api/intel/openapi.json",
        redoc_url=None,
    )
    # DNS-rebinding defence: only requests addressed to this machine by name.
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(settings.allowed_hosts))
    app.include_router(router)
    app.include_router(chat_router)
    app.include_router(voice_router)
    app.include_router(providers_router)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, error: RequestValidationError) -> JSONResponse:
        # FastAPI's default body echoes the rejected input, which on
        # /providers/{id}/key is an API key.
        detail: list[dict[str, Any]] = [
            {
                "loc": [redact(str(part)) for part in item.get("loc", ())],
                "msg": redact(str(item.get("msg", ""))),
                "type": item.get("type"),
            }
            for item in error.errors()
        ]
        return JSONResponse(status_code=422, content={"detail": detail})

    return app


def create_default_app() -> FastAPI:
    """uvicorn factory: settings from the environment and `.env`."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    return create_app()
