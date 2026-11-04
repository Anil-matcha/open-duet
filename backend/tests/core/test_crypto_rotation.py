"""Key rotation re-encrypts stored credentials under the newest key.

crypto.rotate must re-write a value that an older key wrote, so an operator can
retire a compromised key: add the new one, rotate, remove the old one.
"""
from cryptography.fernet import Fernet, MultiFernet
from sqlalchemy import select

from app.core import crypto
from app.db.models.user_credential import UserCredential
from app.server import rotate_keys


def _use(monkeypatch, keys):
    """Point crypto at these keys, primary first (as the module builds it)."""
    monkeypatch.setattr(crypto, "_keys", keys)
    monkeypatch.setattr(crypto, "_primary", keys[0])
    monkeypatch.setattr(crypto, "_fernet", MultiFernet(keys))


def test_rotate_re_encrypts_a_value_the_old_key_wrote(monkeypatch):
    old_bytes, new_bytes = Fernet.generate_key(), Fernet.generate_key()
    # A value the old key wrote (as it was when old was the primary).
    sealed_old = Fernet(old_bytes).encrypt(b"ghp_secret_token").decode()
    _use(monkeypatch, [Fernet(new_bytes), Fernet(old_bytes)])  # new primary; old still configured
    assert crypto.is_primary(sealed_old) is False

    sealed_new = crypto.rotate(sealed_old)

    assert crypto.decrypt(sealed_old) == "ghp_secret_token"
    assert crypto.decrypt(sealed_new) == "ghp_secret_token"
    assert crypto.is_primary(sealed_new) is True
    # The re-encrypted value opens with the new key alone, so the old key can go.
    assert Fernet(new_bytes).decrypt(sealed_new.encode()).decode() == "ghp_secret_token"


async def test_rotate_credentials_rewrites_only_the_stale_rows(db_session, monkeypatch):
    old_bytes, new_bytes = Fernet.generate_key(), Fernet.generate_key()
    stale = Fernet(old_bytes).encrypt(b"stale-secret").decode()
    db_session.add(UserCredential(user_id="u1", provider="p1", file_path="/a", ciphertext=stale))
    await db_session.commit()
    _use(monkeypatch, [Fernet(new_bytes), Fernet(old_bytes)])  # rotate to the new primary
    monkeypatch.setattr(rotate_keys, "AsyncSessionLocal", lambda: _session(db_session))

    assert await rotate_keys.rotate_credentials() == 1
    row = (await db_session.execute(select(UserCredential))).scalar_one()
    assert crypto.decrypt(row.ciphertext) == "stale-secret"
    assert crypto.is_primary(row.ciphertext) is True
    # A second pass finds nothing left to rewrite.
    assert await rotate_keys.rotate_credentials() == 0


async def test_rotate_credentials_refuses_when_a_key_is_missing(db_session, monkeypatch):
    old = Fernet(Fernet.generate_key())
    _use(monkeypatch, [old])
    sealed = crypto.encrypt("orphan-secret")
    db_session.add(UserCredential(user_id="u1", provider="p1", file_path="/a", ciphertext=sealed))
    await db_session.commit()
    # The writer's key is gone: the secret cannot be opened, so rotation refuses.
    _use(monkeypatch, [Fernet(Fernet.generate_key())])
    monkeypatch.setattr(rotate_keys, "AsyncSessionLocal", lambda: _session(db_session))

    try:
        await rotate_keys.rotate_credentials()
        assert False, "expected RotationRefused"
    except rotate_keys.RotationRefused:
        pass


class _session:
    """A context manager yielding the one test session (mirrors AsyncSessionLocal)."""

    def __init__(self, db):
        self._db = db

    async def __aenter__(self):
        return self._db

    async def __aexit__(self, *exc):
        return False
