"""SKYNET intel service: FastAPI app factory and entry point.

Start it with scripts/skynet.ps1, which runs uvicorn on 127.0.0.1:8100 with
this module's create_default_app as a factory.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator

import httpx
from fastapi import FastAPI
from fastapi.middleware.trustedhost import TrustedHostMiddleware

from .api.routes import router
from .config import BRAND_NAME, Settings, load_settings
from .geo.gazetteer import Gazetteer
from .geo.geoparse import GeoParser
from .hub import EventHub
from .ingest.feeds import load_feed_config
from .ingest.pipeline import Pipeline
from .ingest.scheduler import Scheduler
from .store.news import NewsStore

log = logging.getLogger("skynet.intel")


def create_app(
    settings: Settings | None = None,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    geoparser: GeoParser | None = None,
    start_scheduler: bool = True,
) -> FastAPI:
    settings = settings or load_settings()

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
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
            await scheduler.drain()
            await client.aclose()
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
    return app


def create_default_app() -> FastAPI:
    """uvicorn factory: settings from the environment and `.env`."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    return create_app()
