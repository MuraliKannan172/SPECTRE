"""Neural Core tools: the server half, and the allowlist for the client half.

Server tools run here. Client (globe) tools run in the browser; their names and
schemas come only from the committed artifact shared/tools/neural-core.tools.json
(written from src/tools/registry.js by `npm run tools:export`), so a browser
cannot add tools. Every call is validated against its schema here, whatever the
model read before making it.

`intel/scripts/export_tools.py` writes SERVER_TOOLS into the artifact's server
half; a test keeps the two equal.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from jsonschema import Draft202012Validator

from ..config import REPO_ROOT
from ..ingest.classify import CATEGORY_ORDER
from ..ingest.feeds import REGIONS

ARTIFACT_PATH = REPO_ROOT / "shared" / "tools" / "neural-core.tools.json"


def _tool(
    name: str, description: str, properties: dict[str, Any], required: list[str] | None = None
) -> dict[str, Any]:
    parameters: dict[str, Any] = {"type": "object", "additionalProperties": False, "properties": properties}
    if required:
        parameters["required"] = required
    return {
        "type": "function",
        "function": {"name": name, "description": description, "parameters": parameters},
    }


_SINCE = {
    "type": "integer",
    "minimum": 1,
    "maximum": 720,
    "description": "Look back this many hours (default 72).",
}
_LIMIT = {"type": "integer", "minimum": 1, "maximum": 10}

SERVER_TOOLS: list[dict[str, Any]] = [
    _tool(
        "news_search",
        "Search the local news store (recent headlines collected from news feeds). Use for news questions.",
        {
            "query": {"type": "string", "minLength": 1, "maxLength": 200, "description": "Keywords."},
            "since_hours": _SINCE,
            "region": {"type": "string", "enum": list(REGIONS)},
            "category": {"type": "string", "enum": list(CATEGORY_ORDER)},
            "limit": _LIMIT,
        },
    ),
    _tool(
        "news_near",
        "News stories placed near a point on the globe.",
        {
            "lat": {"type": "number", "minimum": -90, "maximum": 90},
            "lon": {"type": "number", "minimum": -180, "maximum": 180},
            "radius_km": {"type": "number", "minimum": 1, "maximum": 3000},
            "since_hours": _SINCE,
            "limit": _LIMIT,
        },
        ["lat", "lon"],
    ),
    _tool(
        "web_search",
        "Search the web. Required for anything current (latest, now, today) or not in the news store.",
        {
            "query": {"type": "string", "minLength": 1, "maxLength": 300},
            "recency": {"type": "string", "enum": ["day", "week", "month", "any"]},
            "limit": {"type": "integer", "minimum": 1, "maximum": 8},
        },
        ["query"],
    ),
    _tool(
        "fetch_page",
        "Read one public web page (http/https) as text, e.g. a search result to check details.",
        {"url": {"type": "string", "minLength": 8, "maxLength": 2048}},
        ["url"],
    ),
    _tool("layer_state", "The map layers that are on, with their options.", {}),
    _tool("viewport", "The camera position, the visible area and the current time.", {}),
]

SERVER_TOOL_NAMES = frozenset(tool["function"]["name"] for tool in SERVER_TOOLS)


@dataclass(frozen=True)
class ToolCheck:
    kind: Literal["server", "client"] | None
    errors: tuple[str, ...]

    @property
    def ok(self) -> bool:
        return self.kind is not None and not self.errors


class ToolRegistry:
    """Every tool the model is offered, with a validator per tool."""

    def __init__(
        self, client_tools: list[dict[str, Any]], server_tools: list[dict[str, Any]] = SERVER_TOOLS
    ) -> None:
        self.server_tools = server_tools
        self.client_tools = client_tools
        self._kinds: dict[str, Literal["server", "client"]] = {}
        self._validators: dict[str, Draft202012Validator] = {}
        for kind, tools in (("server", server_tools), ("client", client_tools)):
            for tool in tools:
                function = tool["function"]
                name = function["name"]
                if name in self._kinds:
                    raise ValueError(f"duplicate tool name {name}")
                Draft202012Validator.check_schema(function["parameters"])
                self._kinds[name] = kind  # type: ignore[assignment]
                self._validators[name] = Draft202012Validator(function["parameters"])

    @classmethod
    def from_artifact(cls, path: Path = ARTIFACT_PATH) -> ToolRegistry:
        artifact = json.loads(path.read_text(encoding="utf-8"))
        client = artifact.get("client")
        if not isinstance(client, list):
            raise ValueError("tool artifact has no client half")
        return cls(client)

    @property
    def all_tools(self) -> list[dict[str, Any]]:
        return [*self.server_tools, *self.client_tools]

    def check(self, name: str, arguments: Any) -> ToolCheck:
        kind = self._kinds.get(name)
        if kind is None:
            return ToolCheck(None, (f"unknown tool {name!r}",))
        if not isinstance(arguments, dict):
            return ToolCheck(kind, ("arguments must be an object",))
        errors = tuple(
            f"{'/'.join(str(part) for part in error.absolute_path) or 'arguments'}: {error.message}"[:200]
            for error in sorted(self._validators[name].iter_errors(arguments), key=str)[:5]
        )
        return ToolCheck(kind, errors)
