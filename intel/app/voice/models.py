"""Pinned local voice models and whether this machine can run them.

Nothing here imports the voice packages: they are an opt-in install
(`uv sync --project intel --extra voice`), and the service must start without
them. The models are fetched by intel/scripts/fetch_voice_models.py into
`settings.voice_dir`, checked against these hashes, and loaded from there only.
"""

from __future__ import annotations

import hashlib
import importlib.util
from dataclasses import dataclass
from pathlib import Path

VOICE_PACKAGES = ("faster_whisper", "kokoro_onnx", "av")
WHISPER_REPO = "Systran/faster-whisper-base"  # MIT, like OpenAI's Whisper weights
WHISPER_REVISION = "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66"
KOKORO_RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"


@dataclass(frozen=True)
class ModelFile:
    path: str  # relative to the voice directory
    url: str
    size: int
    sha256: str


def _whisper(name: str, size: int, sha256: str) -> ModelFile:
    url = f"https://huggingface.co/{WHISPER_REPO}/resolve/{WHISPER_REVISION}/{name}"
    return ModelFile(f"whisper-base/{name}", url, size, sha256)


MODEL_FILES = (
    _whisper("config.json", 2309, "56a6d8110d311f19c8f0471e562832c7527f146b567275bfca59fcf7c184da9a"),
    _whisper("model.bin", 145217532, "d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9"),
    _whisper("tokenizer.json", 2203239, "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab"),
    _whisper("vocabulary.txt", 459861, "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913"),
    # Kokoro-82M (Apache-2.0), int8 ONNX export and voice pack from kokoro-onnx (MIT).
    ModelFile(
        "kokoro/kokoro-v1.0.int8.onnx",
        KOKORO_RELEASE + "kokoro-v1.0.int8.onnx",
        92361271,
        "6e742170d309016e5891a994e1ce1559c702a2ccd0075e67ef7157974f6406cb",
    ),
    ModelFile(
        "kokoro/voices-v1.0.bin",
        KOKORO_RELEASE + "voices-v1.0.bin",
        28214398,
        "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
    ),
)
WHISPER_DIR = "whisper-base"
KOKORO_MODEL = "kokoro/kokoro-v1.0.int8.onnx"
KOKORO_VOICES = "kokoro/voices-v1.0.bin"


def packages_installed() -> bool:
    return all(importlib.util.find_spec(name) is not None for name in VOICE_PACKAGES)


def missing_files(voice_dir: Path) -> list[str]:
    """Model files that are absent or the wrong size (hashes are checked at fetch time)."""
    missing = []
    for item in MODEL_FILES:
        path = voice_dir / item.path
        if not path.is_file() or path.stat().st_size != item.size:
            missing.append(item.path)
    return missing


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def unavailable_reason(*, enabled: bool, voice_dir: Path, installed: bool | None = None) -> str | None:
    """Why local voice cannot run here, as a code the panel explains; None when it can."""
    if not enabled:
        return "disabled"
    if not (packages_installed() if installed is None else installed):
        return "not_installed"
    if missing_files(voice_dir):
        return "models_missing"
    return None
