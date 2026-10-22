"""Phase 0 probe: native tool calling on local Ollama models.

Usage (PowerShell, repo root):
    python docs/phase0/ollama_tool_probe.py qwen3.5-9b-64k-gpu:latest bonsai-2:9b

Sends 5 tool prompts plus 1 no-tool control to /api/chat (non-streaming,
think=false, num_ctx=8192) and grades each reply against the expected tool
calls and the JSON schema below. Stdlib only.
"""

import json
import subprocess
import sys
import time
import urllib.request

OLLAMA = "http://127.0.0.1:11434"
NUM_CTX = 8192

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "fly_to",
            "description": "Move the globe camera to a coordinate.",
            "parameters": {
                "type": "object",
                "properties": {
                    "lat": {"type": "number", "description": "Latitude in degrees"},
                    "lon": {"type": "number", "description": "Longitude in degrees"},
                    "altitude_m": {"type": "number", "description": "Camera altitude in metres"},
                },
                "required": ["lat", "lon"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "toggle_layer",
            "description": "Turn one map data layer on or off.",
            "parameters": {
                "type": "object",
                "properties": {
                    "layer": {
                        "type": "string",
                        "enum": ["flights", "vessels", "satellites", "earthquakes", "fires", "news"],
                    },
                    "enabled": {"type": "boolean"},
                },
                "required": ["layer", "enabled"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "news_search",
            "description": "Search the local news store (ingested RSS/GDELT headlines).",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "since": {"type": "string", "description": "Relative window like 24h or 7d"},
                    "region": {"type": "string"},
                    "category": {"type": "string"},
                    "limit": {"type": "integer"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the live web for fresh information.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "recency": {"type": "string", "enum": ["day", "week", "month", "any"]},
                    "limit": {"type": "integer"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_page",
            "description": "Fetch a public web page and return its readable text.",
            "parameters": {
                "type": "object",
                "properties": {"url": {"type": "string"}},
                "required": ["url"],
            },
        },
    },
]

SYSTEM = (
    "You are the SKYNET globe assistant. Use the provided tools to control the "
    "globe, search the local news store, and check the web. For questions about "
    "the latest/current state of the world, call web_search before answering. "
    "Only call tools that are needed."
)


def near(value, target, tol):
    return isinstance(value, (int, float)) and abs(value - target) <= tol


def check_fly(calls):
    return len(calls) == 1 and calls[0]["name"] == "fly_to" and near(
        calls[0]["arguments"].get("lat"), 35.68, 1.0
    ) and near(calls[0]["arguments"].get("lon"), 139.69, 1.0)


def check_toggle(calls):
    got = {(c["name"], c["arguments"].get("layer"), c["arguments"].get("enabled")) for c in calls}
    return got == {("toggle_layer", "earthquakes", True), ("toggle_layer", "flights", False)}


def check_news(calls):
    return (
        len(calls) == 1
        and calls[0]["name"] == "news_search"
        and "sudan" in str(calls[0]["arguments"].get("query", "")).lower()
        and calls[0]["arguments"].get("since") not in (None, "")
    )


def check_web(calls):
    return len(calls) >= 1 and calls[0]["name"] == "web_search" and "iss" in json.dumps(
        calls[0]["arguments"]
    ).lower()


def check_fetch(calls):
    return (
        len(calls) == 1
        and calls[0]["name"] == "fetch_page"
        and calls[0]["arguments"].get("url", "").rstrip("/") == "https://example.com"
    )


def check_none(calls):
    return len(calls) == 0


PROMPTS = [
    ("globe: fly", "Fly the camera to Tokyo.", check_fly),
    ("globe: 2 toggles", "Turn on the earthquakes layer and turn off flights.", check_toggle),
    ("news store", "What news do we have about Sudan from the last 24 hours?", check_news),
    ("web freshness", "Who is on board the ISS right now?", check_web),
    ("fetch page", "Read https://example.com and tell me what it says.", check_fetch),
    ("control: no tool", "What is 17 multiplied by 3? Answer directly.", check_none),
]


def chat(model, prompt):
    body = {
        "model": model,
        "stream": False,
        "think": False,
        "keep_alive": "5m",
        "options": {"num_ctx": NUM_CTX, "temperature": 0.2},
        "tools": TOOLS,
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}],
    }
    req = urllib.request.Request(
        f"{OLLAMA}/api/chat",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    started = time.perf_counter()
    with urllib.request.urlopen(req, timeout=300) as resp:
        data = json.loads(resp.read())
    return data, time.perf_counter() - started


def normalize_calls(message):
    calls = []
    for call in message.get("tool_calls") or []:
        fn = call.get("function", {})
        args = fn.get("arguments", {})
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                args = {"_unparsed": args}
        calls.append({"name": fn.get("name"), "arguments": args})
    return calls


def probe(model):
    print(f"\n=== {model}")
    rows = []
    for label, prompt, check in PROMPTS:
        try:
            data, wall = chat(model, prompt)
        except Exception as exc:  # report, never hide
            print(f"  ERROR {label}: {exc}")
            rows.append({"label": label, "pass": False, "error": str(exc)})
            continue
        msg = data.get("message", {})
        calls = normalize_calls(msg)
        ok = check(calls)
        eval_count = data.get("eval_count", 0)
        eval_ns = data.get("eval_duration", 0) or 1
        tps = eval_count / (eval_ns / 1e9)
        row = {
            "label": label,
            "pass": ok,
            "calls": calls,
            "content": (msg.get("content") or "")[:160],
            "wall_s": round(wall, 2),
            "load_s": round(data.get("load_duration", 0) / 1e9, 2),
            "tok_per_s": round(tps, 1),
        }
        rows.append(row)
        print(f"  {'PASS' if ok else 'FAIL'} {label:18} {wall:6.2f}s {tps:6.1f} tok/s  {json.dumps(calls)[:200]}")
    ps = subprocess.run(["ollama", "ps"], capture_output=True, text=True).stdout.strip()
    print(ps)
    passed = sum(r["pass"] for r in rows[:5])
    print(f"  tool prompts passed: {passed}/5; control {'PASS' if rows[5]['pass'] else 'FAIL'}")
    return {"model": model, "rows": rows, "ollama_ps": ps, "tool_pass": passed}


if __name__ == "__main__":
    results = [probe(m) for m in sys.argv[1:]]
    with open("docs/phase0/ollama_probe_results.json", "w", encoding="utf-8") as fh:
        json.dump(results, fh, indent=2)
