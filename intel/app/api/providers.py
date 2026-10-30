"""Neural Core provider API under /api/intel/providers (ADR-002 D5, D6).

Keys are write-only: no route returns a key, a prefix or a suffix. Every route
refuses a request carrying an Origin header or a cross-site marker (only the
app's proxy, which runs the POWER UP admission gate, reaches it), and every
write needs the session token this service issued at start-up, fetched from
GET /providers/session. Local-only mode blocks any call to a cloud provider,
including a connection test and a model list.
"""

from __future__ import annotations

import hmac
from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from ..chat.providers.base import ChatProvider, ModelInfo
from ..chat.providers.errors import ProviderError
from ..chat.providers.keys import KeyStoreError
from ..chat.providers.registry import ProviderSpec, base_url_problem
from ..store.providers import ProviderSettings
from .chat import _json_body, _same_machine

router = APIRouter(prefix="/api/intel/providers")

SESSION_HEADER = "x-spectre-session"
_KEY_ERRORS = {"no_key": 400, "bad_key": 400, "external": 409, "keyring_failed": 503}


class KeyBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(..., min_length=1, max_length=1024)


class SettingsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_url: str | None = Field(None, max_length=512)
    workspace_id: str | None = Field(None, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")


class ConsentBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    granted: bool


class PolicyBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    local_only: bool | None = None
    map_context: bool | None = None


class TestBody(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _state(request: Request) -> Any:
    _same_machine(request)
    state = request.app.state
    if getattr(state, "providers", None) is None:
        raise HTTPException(
            503, {"code": "providers_unavailable", "reason": getattr(state, "chat_problem", None)}
        )
    return state


def _writer(request: Request, *, body: bool = True) -> Any:
    state = _state(request)
    if body:
        _json_body(request)
    token = request.headers.get(SESSION_HEADER, "")
    if not hmac.compare_digest(token.encode(), state.session_token.encode()):
        raise HTTPException(403, {"code": "session_required"})
    return state


def _spec(state: Any, provider_id: str) -> ProviderSpec:
    spec = state.providers.specs.get(provider_id)
    if spec is None:
        raise HTTPException(404, {"code": "unknown_provider"})
    return spec


def _kind(state: Any, spec: ProviderSpec) -> str:
    provider = state.providers.get(spec.id)
    return getattr(provider, "kind", spec.kind)


def _egress_allowed(state: Any, spec: ProviderSpec) -> None:
    if _kind(state, spec) == "cloud" and state.provider_store.policy().local_only:
        raise HTTPException(409, {"code": "local_only", "message": "Local-only mode blocks cloud providers"})


def _view(state: Any, spec: ProviderSpec) -> dict[str, Any]:
    saved = state.provider_store.settings(spec.id)
    provider: ChatProvider | None = state.providers.get(spec.id)
    return {
        "id": spec.id,
        "label": spec.label,
        "kind": _kind(state, spec),
        "docs": spec.docs or None,
        "base_url": _base_url(provider, spec),
        "base_url_editable": spec.id != "ollama",
        "workspace_id": saved.workspace_id,
        "key": state.keys.status(spec).public(),
        "consent": state.provider_store.consented(spec.id),
    }


def _base_url(provider: ChatProvider | None, spec: ProviderSpec) -> str:
    client = getattr(provider, "client", None)
    return str(getattr(provider, "base_url", None) or getattr(client, "base_url", None) or spec.base_url)


def _model(info: ModelInfo) -> dict[str, Any]:
    data = asdict(info)
    data["capabilities"] = sorted(info.capabilities)
    return data


def _provider_failure(error: ProviderError) -> HTTPException:
    return HTTPException(502, {"code": error.code, "message": str(error), "retryable": error.retryable})


@router.get("")
async def list_providers(request: Request) -> dict[str, Any]:
    state = _state(request)
    policy = state.provider_store.policy()
    return {
        "providers": [_view(state, spec) for spec in state.providers.specs.values()],
        "policy": {"local_only": policy.local_only, "map_context": policy.map_context},
        "keyring": state.keys.keyring_available,
    }


@router.get("/session")
async def session(request: Request) -> dict[str, str]:
    return {"token": _state(request).session_token}


@router.put("/policy")
async def set_policy(body: PolicyBody, request: Request) -> dict[str, bool]:
    state = _writer(request)
    policy = state.provider_store.set_policy(local_only=body.local_only, map_context=body.map_context)
    return {"local_only": policy.local_only, "map_context": policy.map_context}


@router.put("/{provider_id}/key")
async def put_key(provider_id: str, body: KeyBody, request: Request) -> dict[str, Any]:
    state = _writer(request)
    try:
        return state.keys.set(_spec(state, provider_id), body.key).public()
    except KeyStoreError as error:
        raise HTTPException(_KEY_ERRORS[error.code], {"code": error.code, "message": str(error)}) from None


@router.delete("/{provider_id}/key")
async def delete_key(provider_id: str, request: Request) -> dict[str, Any]:
    state = _writer(request, body=False)
    try:
        return state.keys.delete(_spec(state, provider_id)).public()
    except KeyStoreError as error:
        raise HTTPException(_KEY_ERRORS[error.code], {"code": error.code, "message": str(error)}) from None


@router.put("/{provider_id}/settings")
async def put_settings(provider_id: str, body: SettingsBody, request: Request) -> dict[str, Any]:
    state = _writer(request)
    spec = _spec(state, provider_id)
    base_url = (body.base_url or "").strip().rstrip("/") or None
    if base_url is not None:
        if spec.id == "ollama":
            raise HTTPException(
                409, {"code": "set_in_environment", "message": "Ollama's address comes from OLLAMA_HOST"}
            )
        problem = base_url_problem(base_url)
        if problem:
            raise HTTPException(400, {"code": "bad_base_url", "message": f"The base URL {problem}"})
    state.provider_store.save_settings(spec.id, ProviderSettings(base_url, body.workspace_id))
    if spec.id != "ollama":
        state.providers.rebuild(spec.id, base_url or spec.base_url)
    return _view(state, spec)


@router.put("/{provider_id}/consent")
async def put_consent(provider_id: str, body: ConsentBody, request: Request) -> dict[str, bool]:
    state = _writer(request)
    spec = _spec(state, provider_id)
    state.provider_store.set_consent(spec.id, body.granted)
    return {"consent": state.provider_store.consented(spec.id)}


@router.post("/{provider_id}/test")
async def test_connection(provider_id: str, body: TestBody, request: Request) -> dict[str, Any]:
    state = _writer(request)
    spec = _spec(state, provider_id)
    _egress_allowed(state, spec)
    try:
        result = await state.providers.get(spec.id).test()
    except ProviderError as error:
        return {"ok": False, "code": error.code, "message": str(error), "retryable": error.retryable}
    return {**result, "ok": True}


@router.get("/{provider_id}/models")
async def models(provider_id: str, request: Request) -> dict[str, Any]:
    state = _state(request)
    spec = _spec(state, provider_id)
    _egress_allowed(state, spec)
    try:
        listed = await state.providers.get(spec.id).list_models()
    except ProviderError as error:
        raise _provider_failure(error) from None
    return {"models": [_model(info) for info in listed]}
