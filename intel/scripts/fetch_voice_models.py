"""Download the pinned local voice models into the voice directory (opt-in, about 270 MB).

Every file is checked against its size and SHA-256 before it is moved into
place, so a partial or altered download is never loaded. Run from the
repository root after `uv sync --project intel --extra voice`:

    uv run --project intel python intel/scripts/fetch_voice_models.py [--check]

Licences: faster-whisper base (Systran, MIT, from OpenAI's MIT Whisper
weights); Kokoro-82M (Apache-2.0) as exported by kokoro-onnx (MIT). The voice
packages also install espeak-ng and phonemizer, which are GPL-3.0 (NOTICE.md).
"""

from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import load_settings  # noqa: E402
from app.voice.models import MODEL_FILES, ModelFile, sha256_of  # noqa: E402

CHUNK = 1 << 20


def present(path: Path, item: ModelFile) -> bool:
    return path.is_file() and path.stat().st_size == item.size and sha256_of(path) == item.sha256


def download(item: ModelFile, path: Path, user_agent: str) -> None:
    part = path.with_name(path.name + ".part")
    path.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    request = urllib.request.Request(item.url, headers={"User-Agent": user_agent})
    with urllib.request.urlopen(request, timeout=60) as response, part.open("wb") as out:
        while block := response.read(CHUNK):
            digest.update(block)
            out.write(block)
            if out.tell() > item.size:
                break
    size = part.stat().st_size
    if size != item.size or digest.hexdigest() != item.sha256:
        part.unlink(missing_ok=True)
        raise RuntimeError(
            f"{item.path}: got {size} bytes, sha256 {digest.hexdigest()[:16]}...; expected a pinned file"
        )
    part.replace(path)


def main() -> int:
    settings = load_settings()
    check_only = "--check" in sys.argv
    failed = 0
    for item in MODEL_FILES:
        path = settings.voice_dir / item.path
        if present(path, item):
            print(f"ok       {item.path}")
            continue
        if check_only:
            print(f"missing  {item.path}")
            failed += 1
            continue
        print(f"fetching {item.path} ({item.size / 1e6:.1f} MB)", flush=True)
        try:
            download(item, path, settings.user_agent)
        except (OSError, RuntimeError) as error:
            print(f"failed   {item.path}: {error}")
            failed += 1
            continue
        print(f"ok       {item.path}")
    print(f"voice models in {settings.voice_dir}: {'incomplete' if failed else 'ready'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
