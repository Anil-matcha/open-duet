from cryptography.fernet import Fernet, MultiFernet

from app.core.config import settings

# The first configured key is the primary: it writes new values and is the one
# everything is re-encrypted under (rotate_keys). The rest only decrypt, so a
# key can be retired by rotating and then removing it.
_keys = [Fernet(key.strip().encode()) for key in settings.TOKEN_ENCRYPTION_KEYS.split(",") if key.strip()]
_primary = _keys[0]
_fernet = MultiFernet(_keys)


def encrypt(plaintext: str) -> str:
    return _fernet.encrypt(plaintext.encode()).decode()


def decrypt(ciphertext: str) -> str:
    return _fernet.decrypt(ciphertext.encode()).decode()


def rotate(ciphertext: str) -> str:
    """Re-encrypt `ciphertext` under the current primary key.

    MultiFernet.decrypt accepts any configured key; rotate() writes the result
    with the first (newest) one. This is what lets an operator retire a
    compromised key: prepend a new key, re-write every stored value, then drop
    the old key. Returns the new ciphertext unchanged only if it already used
    the primary key."""
    return _fernet.rotate(ciphertext.encode()).decode()


def is_primary(ciphertext: str) -> bool:
    """True when the value already opens with the primary (newest) key alone, so
    a rotation pass can skip it. Fernet ciphertexts carry a random IV, so two
    encryptions of the same plaintext never match; only a trial decrypt tells."""
    try:
        _primary.decrypt(ciphertext.encode())
        return True
    except Exception:  # noqa: BLE001 - any failure means a different key wrote it
        return False
