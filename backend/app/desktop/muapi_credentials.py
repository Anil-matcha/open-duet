"""Profile-bound Muapi API key for Muapi cloud computers (Desktop app).

Same encrypted, write-only storage as the Boat key, in its own file. This
module only stores the key; it makes no Muapi calls.
"""

from __future__ import annotations

import asyncio

from app.desktop.boat_credentials import BoatCredentials, CredentialError, MAX_KEY_LENGTH  # noqa: F401

FILE_NAME = "muapi-api-key.enc"

# Serializes key changes against creation of the first Muapi computer row.
configuration_lock = asyncio.Lock()


class MuapiCredentials(BoatCredentials):
    FILE_NAME = FILE_NAME


def get_store() -> MuapiCredentials:
    return MuapiCredentials()
