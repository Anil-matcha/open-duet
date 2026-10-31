"""Credential-file names shared by the workspace browser and the computer tools.

Kept free of `app.core.config` and the database so the computer's MCP child can
import it with the minimal environment it is started with.
"""

import fnmatch


SECRET_DIRS = {".git", ".ssh", ".aws", ".gnupg"}
SECRET_NAMES = (
    ".env",
    ".env.*",
    ".netrc",
    ".npmrc",
    ".pypirc",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "id_rsa*",
    "id_ed25519*",
    "id_ecdsa*",
)


def is_secret(parts: tuple[str, ...]) -> bool:
    lowered = [part.lower() for part in parts]
    if any(part in SECRET_DIRS for part in lowered[:-1]) or (lowered and lowered[-1] in SECRET_DIRS):
        return True
    return bool(lowered) and any(fnmatch.fnmatchcase(lowered[-1], pattern) for pattern in SECRET_NAMES)
