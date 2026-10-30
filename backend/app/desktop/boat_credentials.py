"""Profile-bound Boat credentials for the Desktop app.

The key is encrypted with the active desktop profile key and is never exposed
to the renderer. This module only stores credentials; it makes no Boat calls.
"""

from __future__ import annotations

import os
import tempfile
import asyncio
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

from app.desktop import profile

FILE_NAME = "boat-api-key.enc"
MAX_KEY_LENGTH = 4096

# Serialize key changes against creation of the first cloud-computer row. The
# row is the durable indication that this key is in use.
configuration_lock = asyncio.Lock()


class CredentialError(Exception):
    """A profile credential could not be read or safely written."""


class BoatCredentials:
    def __init__(self, *, data_dir: Path | None = None, encryption_key: str | None = None) -> None:
        current = profile.current()
        if current is None and (data_dir is None or encryption_key is None):
            raise RuntimeError("Desktop profile is not active.")
        self.data_dir = Path(data_dir) if data_dir is not None else current.data_dir
        keyset = encryption_key if encryption_key is not None else current.encryption_key
        try:
            self._cipher = MultiFernet([
                Fernet(key.strip().encode("ascii"))
                for key in keyset.split(",") if key.strip()
            ])
        except (ValueError, TypeError, UnicodeEncodeError):
            raise CredentialError("profile_storage_error") from None

    @property
    def path(self) -> Path:
        return self.data_dir / FILE_NAME

    def configured(self) -> bool:
        return self.get() is not None

    def get(self) -> str | None:
        try:
            encrypted = self.path.read_bytes()
        except FileNotFoundError:
            return None
        except OSError:
            raise CredentialError("profile_storage_error") from None
        try:
            value = self._cipher.decrypt(encrypted).decode("utf-8")
        except (InvalidToken, UnicodeDecodeError, ValueError):
            raise CredentialError("profile_storage_error") from None
        if not value or len(value) > MAX_KEY_LENGTH:
            raise CredentialError("profile_storage_error")
        return value

    def set(self, value: str) -> None:
        if not isinstance(value, str):
            raise ValueError("invalid_key")
        value = value.strip()
        if not value or len(value) > MAX_KEY_LENGTH or "\x00" in value:
            raise ValueError("invalid_key")
        encrypted = self._cipher.encrypt(value.encode("utf-8"))
        self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary: str | None = None
        try:
            fd, temporary = tempfile.mkstemp(prefix=f".{FILE_NAME}.", dir=self.data_dir)
            with os.fdopen(fd, "wb") as stream:
                os.fchmod(stream.fileno(), 0o600)
                stream.write(encrypted)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
            temporary = None
            os.chmod(self.path, 0o600)
        except OSError:
            raise CredentialError("profile_storage_error") from None
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass

    def delete(self) -> None:
        try:
            self.path.unlink(missing_ok=True)
        except OSError:
            raise CredentialError("profile_storage_error") from None


def get_store() -> BoatCredentials:
    return BoatCredentials()
