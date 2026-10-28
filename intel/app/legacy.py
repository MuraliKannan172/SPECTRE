"""One-time carry-over from the SKYNET names (renamed SPECTRE on 2026-10-28).

The database and the tool-log folder are copied to their new names the first
time the service starts after the rename. Nothing is ever deleted: the old
files stay where they were until their owner removes them. Only the default
locations migrate; a path set in the environment is the owner's choice.
Remove this module in the release after next.
"""

from __future__ import annotations

import logging
import shutil
import sqlite3
from pathlib import Path

log = logging.getLogger("spectre.intel")

LEGACY_DB_NAME = "skynet.db"
LEGACY_LOGS_NAME = ".skynet-logs"


def migrate_database(new: Path, old: Path) -> bool:
    """Copy `old` to `new` with SQLite's backup API (consistent even if a WAL
    is in use), unless `new` already exists or `old` does not. Returns whether
    a copy was made; a failure is logged, never raised."""
    if new.exists() or not old.is_file():
        return False
    try:
        new.parent.mkdir(parents=True, exist_ok=True)
        source = sqlite3.connect(old)
        try:
            target = sqlite3.connect(new)
            try:
                source.backup(target)
            finally:
                target.close()
        finally:
            source.close()
    except (OSError, sqlite3.Error) as error:
        log.warning("could not copy %s to %s: %s", old.name, new.name, error)
        new.unlink(missing_ok=True)  # only the partial copy this call made
        return False
    log.info("copied %s to %s (the old file is kept)", old, new)
    return True


def migrate_logs(new: Path, old: Path) -> bool:
    """Copy the old log folder to `new` unless `new` exists or `old` does not."""
    if new.exists() or not old.is_dir():
        return False
    try:
        shutil.copytree(old, new)
    except OSError as error:
        log.warning("could not copy %s to %s: %s", old.name, new.name, error)
        return False
    log.info("copied %s to %s (the old folder is kept)", old, new)
    return True


def migrate_defaults(*, db_path: Path, default_db: Path, logs_dir: Path, default_logs: Path) -> None:
    """Carry the old database and logs over when the new defaults are in use."""
    if db_path == default_db:
        migrate_database(db_path, db_path.with_name(LEGACY_DB_NAME))
    if logs_dir == default_logs:
        migrate_logs(logs_dir, logs_dir.with_name(LEGACY_LOGS_NAME))
