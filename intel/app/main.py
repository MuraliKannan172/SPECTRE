"""SPECTRE intel service: FastAPI app factory and entry point.

Start it with scripts/spectre.ps1, which runs uvicorn on 127.0.0.1:8100 with
this module's create_default_app as a factory.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
from fastapi import FastAPI
from fastapi.middleware.trustedhost import TrustedHostMiddleware

from .api.chat import ChatGate
from .api.chat import router as chat_router
from .api.routes import router
from .api.voice import router as voice_router
from .chat.agent import Agent
from .chat.providers.base import ChatProvider
from .chat.providers.registry import DEFAULT_PATH as PROVIDERS_FILE
from .chat.providers.registry import ProviderConfigError, default_providers
from .chat.tools import ToolRegistry
from .config import BRAND_NAME, DEFAULT_DB, DEFAULT_LOGS, Settings, load_settings
from .geo.gazetteer import Gazetteer
from .geo.geoparse import GeoParser
from .hub import EventHub
from .ingest.feeds import load_feed_config
from .ingest.pipeline import Pipeline
from .ingest.scheduler import Scheduler
from .legacy import migrate_defaults
from .store.chat import ChatStore
from .store.news import NewsStore
from .voice.service import VoiceService
from .web.fetch import TIMEOUT_SECONDS as FETCH_TIMEOUT
from .web.fetch import PageFetcher
from .web.guard import guarded_client
from .web.search import SearchService, make_search_service

log = logging.getLogger("spectre.intel")


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
) -> FastAPI:
    settings = settings or load_settings()

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
        # A bad provider file disables chat only; news, events and voice keep running.
        providers: dict[str, ChatProvider] = {}
        try:
            providers = default_providers(
                ollama_http=ollama_http, ollama_host=settings.ollama_host, path=providers_file
            )
        except (OSError, ValueError, ProviderConfigError) as error:
            app.state.chat_problem = f"{providers_file.name} unreadable ({type(error).__name__}): {error}"
        ollama = providers.get("ollama")
        if ollama is None and app.state.chat_problem is None:
            app.state.chat_problem = f"{providers_file.name} has no ollama entry"
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
            await fetch_http.aclose()
            chats.close()
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
    return app


def create_default_app() -> FastAPI:
    """uvicorn factory: settings from the environment and `.env`."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    return create_app()
