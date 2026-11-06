"""Profile-bound boxd credentials for the Desktop app.

Stored exactly like the Boat key (app/desktop/boat_credentials.py): encrypted
with the active desktop profile key, owner-only, never exposed to the
renderer. This module only stores credentials; it makes no boxd calls.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from app.desktop.boat_credentials import MAX_KEY_LENGTH, BoatCredentials, CredentialError

__all__ = ["FILE_NAME", "MAX_KEY_LENGTH", "BoxdCredentials", "CredentialError", "configuration_lock", "get_store"]

FILE_NAME = "boxd-api-key.enc"

# Serialize key changes against creation of the first boxd computer row.
configuration_lock = asyncio.Lock()


class BoxdCredentials(BoatCredentials):
    @property
    def path(self) -> Path:
        return self.data_dir / FILE_NAME


def get_store() -> BoxdCredentials:
    return BoxdCredentials()
