"""Write the server half of shared/tools/neural-core.tools.json.

The client half is written by `npm run tools:export` from src/tools/registry.js;
this keeps it as it is. Run from the repository root:

    uv run --project intel python intel/scripts/export_tools.py [--check]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.chat.tools import ARTIFACT_PATH, SERVER_TOOLS  # noqa: E402


def render(current: dict) -> str:
    artifact = {"version": 1, "client": current.get("client", []), "server": SERVER_TOOLS}
    return json.dumps(artifact, indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    text = ARTIFACT_PATH.read_text(encoding="utf-8") if ARTIFACT_PATH.exists() else "{}"
    rendered = render(json.loads(text))
    if "--check" in sys.argv:
        if rendered != text:
            print(f"{ARTIFACT_PATH} server half is out of date: run intel/scripts/export_tools.py")
            return 1
        print("server half is current")
        return 0
    ARTIFACT_PATH.parent.mkdir(parents=True, exist_ok=True)
    ARTIFACT_PATH.write_text(rendered, encoding="utf-8", newline="\n")
    print(f"wrote {ARTIFACT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
