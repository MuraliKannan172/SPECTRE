"""SKYNET -> SPECTRE: old setting names still read, and old files copied once, never deleted."""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

import pytest
from helpers import FEEDS_YAML, make_settings

from app import config
from app.config import lookup
from app.legacy import migrate_database, migrate_defaults, migrate_logs


@pytest.fixture(autouse=True)
def _fresh_warnings() -> None:
    config._warned_legacy.clear()


def test_the_new_name_wins_and_the_old_one_still_works_with_one_warning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    assert lookup("SPECTRE_VOICE", {"SPECTRE_VOICE": "0", "SKYNET_VOICE": "1"}) == "0"
    with caplog.at_level(logging.WARNING, logger="spectre.intel"):
        assert lookup("SPECTRE_VOICE", {"SKYNET_VOICE": "1"}) == "1"
        assert lookup("SPECTRE_VOICE", {"SKYNET_VOICE": "1"}) == "1"
    assert [r.getMessage() for r in caplog.records] == [
        "SKYNET_VOICE is deprecated: rename it to SPECTRE_VOICE (works for one more release)"
    ]
    assert lookup("SPECTRE_VOICE", {}) is None
    assert lookup("OLLAMA_MODEL", {"SKYNET_MODEL": "x"}) is None  # only SPECTRE_ names fall back


def test_the_process_environment_beats_env_whichever_name_each_uses() -> None:
    environ = {"SKYNET_INTEL_POLL_SECONDS": "60"}
    dotenv = {"SPECTRE_INTEL_POLL_SECONDS": "90"}
    assert lookup("SPECTRE_INTEL_POLL_SECONDS", environ, dotenv) == "60"
    assert lookup("SPECTRE_INTEL_POLL_SECONDS", {}, dotenv) == "90"


def test_settings_read_old_names_from_env_and_the_switch_re_reads_them(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("SKYNET_INTEL_POLL_SECONDS=120\nSKYNET_NONCOMMERCIAL_SOURCES=1\n", encoding="utf-8")
    settings = config.load_settings({"SPECTRE_ENV_FILE": str(env_file)})
    assert settings.poll_seconds == 120
    assert settings.noncommercial_enabled({}) is True
    # Provider Settings turned it off under the new name and retired the old line.
    env_file.write_text(
        "# SKYNET_NONCOMMERCIAL_SOURCES=\n# SPECTRE_NONCOMMERCIAL_SOURCES=\n", encoding="utf-8"
    )
    assert settings.noncommercial_enabled({}) is False


def _database(path: Path, rows: int) -> None:
    with sqlite3.connect(path) as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE story (id INTEGER PRIMARY KEY, title TEXT)")
        db.executemany("INSERT INTO story (title) VALUES (?)", [(f"t{i}",) for i in range(rows)])
    db.close()


def _count(path: Path) -> int:
    db = sqlite3.connect(path)
    try:
        return db.execute("SELECT COUNT(*) FROM story").fetchone()[0]
    finally:
        db.close()


def test_a_fresh_install_has_nothing_to_carry_over(tmp_path: Path) -> None:
    assert migrate_database(tmp_path / "spectre.db", tmp_path / "skynet.db") is False
    assert migrate_logs(tmp_path / ".spectre-logs", tmp_path / ".skynet-logs") is False
    assert not (tmp_path / "spectre.db").exists()
    assert not (tmp_path / ".spectre-logs").exists()


def test_an_upgrade_copies_the_database_and_logs_and_keeps_the_old_ones(tmp_path: Path) -> None:
    old_db, new_db = tmp_path / "skynet.db", tmp_path / "spectre.db"
    _database(old_db, 3)
    old_logs = tmp_path / ".skynet-logs"
    old_logs.mkdir()
    (old_logs / "tools-20261027.jsonl").write_text('{"tool": "web_search"}\n', encoding="utf-8")

    assert migrate_database(new_db, old_db) is True
    assert migrate_logs(tmp_path / ".spectre-logs", old_logs) is True
    assert _count(new_db) == 3
    assert _count(old_db) == 3
    assert (tmp_path / ".spectre-logs" / "tools-20261027.jsonl").read_text(encoding="utf-8")
    assert (old_logs / "tools-20261027.jsonl").exists()


def test_running_twice_never_overwrites_the_new_files(tmp_path: Path) -> None:
    old_db, new_db = tmp_path / "skynet.db", tmp_path / "spectre.db"
    _database(old_db, 3)
    assert migrate_database(new_db, old_db) is True
    with sqlite3.connect(new_db) as db:
        db.execute("INSERT INTO story (title) VALUES ('written after the rename')")
    db.close()
    assert migrate_database(new_db, old_db) is False
    assert _count(new_db) == 4


def test_storage_that_cannot_be_written_is_logged_not_raised(tmp_path: Path) -> None:
    old_db = tmp_path / "skynet.db"
    _database(old_db, 2)
    blocked = tmp_path / "not-a-folder"
    blocked.write_text("a file where the data folder should be", encoding="utf-8")
    assert migrate_database(blocked / "spectre.db", old_db) is False
    old_logs = tmp_path / ".skynet-logs"
    old_logs.mkdir()
    assert migrate_logs(blocked / ".spectre-logs", old_logs) is False
    assert _count(old_db) == 2


def test_only_the_default_locations_migrate(tmp_path: Path) -> None:
    data = tmp_path / "data"
    data.mkdir()
    _database(data / "skynet.db", 1)
    custom = tmp_path / "elsewhere.db"
    migrate_defaults(
        db_path=custom,
        default_db=data / "spectre.db",
        logs_dir=tmp_path / ".spectre-logs",
        default_logs=tmp_path / ".spectre-logs",
    )
    assert not custom.exists()
    migrate_defaults(
        db_path=data / "spectre.db",
        default_db=data / "spectre.db",
        logs_dir=tmp_path / "logs",
        default_logs=tmp_path / ".spectre-logs",
    )
    assert _count(data / "spectre.db") == 1


def test_test_settings_never_point_at_real_data(tmp_path: Path) -> None:
    settings = make_settings(tmp_path, FEEDS_YAML)
    assert tmp_path in settings.db_path.parents
