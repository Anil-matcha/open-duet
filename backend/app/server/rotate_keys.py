"""Re-encrypt stored credentials under the current primary key.

MultiFernet (app/core/crypto.py) can open a value with any configured key, but
only ever writes with the first. So to retire a key — for example, because it
leaked — an operator adds the new key at the front of TOKEN_ENCRYPTION_KEYS,
runs this, and only then removes the old key. Without it, removing a key makes
every credential written by it permanently unreadable.

This is an explicit operator action (`python -m app.server rotate-keys`), never
an automatic migration: it rewrites rows, so it belongs in a maintenance window
with the server stopped. SQLite databases are copied aside first, exactly as
`migrate` does.
"""

import sys
from collections.abc import Sequence

from sqlalchemy import select, update

from app.core import crypto
from app.db.models.user_credential import UserCredential
from app.db.session import AsyncSessionLocal
from app.server.database import DatabaseRefused, prepare_database


class RotationRefused(Exception):
    """A credential could not be opened with the configured keys."""


async def rotate_credentials() -> int:
    """Re-encrypt every stored credential under the primary key.

    Returns how many rows were rewritten. Raises RotationRefused (leaving the
    rows untouched) if any value cannot be decrypted with the configured keys —
    that means a key was removed before rotating.
    """
    rewritten = 0
    async with AsyncSessionLocal() as db:
        rows = list((await db.execute(select(UserCredential))).scalars())
        for row in rows:
            if crypto.is_primary(row.ciphertext):
                continue  # already under the newest key
            try:
                new = crypto.rotate(row.ciphertext)
            except Exception as exc:  # noqa: BLE001 - any failure to open counts
                raise RotationRefused(
                    "A stored credential cannot be decrypted with the current TOKEN_ENCRYPTION_KEYS. "
                    "Put the key that wrote it back first, rotate, and only then remove the old key."
                ) from exc
            await db.execute(
                update(UserCredential).where(UserCredential.id == row.id).values(ciphertext=new)
            )
            rewritten += 1
        await db.commit()
    return rewritten


def main(argv: Sequence[str] = ()) -> int:
    args = list(argv)
    if args and args[0] not in ("-h", "--help"):
        print("usage: python -m app.server rotate-keys", file=sys.stderr)
        return 2
    if args:
        print("Re-encrypt stored credentials under the newest TOKEN_ENCRYPTION_KEYS entry.")
        print("Start with both the new and the old key configured, run this, then remove the old key.")
        return 0
    try:
        prepare_database()
    except DatabaseRefused as exc:
        print(f"Open Duet server: {exc}", file=sys.stderr)
        return 3
    import asyncio

    try:
        count = asyncio.run(rotate_credentials())
    except RotationRefused as exc:
        print(f"Open Duet server: {exc}", file=sys.stderr)
        return 3
    print(f"Re-encrypted {count} stored credential(s) under the newest key." if count
          else "Nothing to do: no stored credential needed re-encrypting.")
    return 0
