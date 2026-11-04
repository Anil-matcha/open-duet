"""The credential a Boat sandbox presents on the permission hook.

The hook endpoint used to compare one install-wide `HOOK_TOKEN` in every
sandbox's `.claude/settings.json`, then trust the `user_id` and `task_id` in the
URL. A token copied out of one sandbox therefore answered permission checks for
any task of any user.

Instead each sandbox is given a token derived from the install secret and the
exact `(user_id, task_id)` the hook URL names. The endpoint recomputes it from
the path, so a token is good for that one task and nothing else, and one found
inside a sandbox cannot be pointed at another user. The install secret never
leaves the backend (`services/task_execution_service.py` writes only the derived
token).
"""

import hashlib
import hmac


def scoped_token(secret: str, user_id: str, task_id: int) -> str:
    """The hook token for one sandbox: an HMAC of its user and task id."""
    message = f"{user_id}\n{int(task_id)}".encode("utf-8")
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()


def token_matches(secret: str, user_id: str, task_id: int, presented: str) -> bool:
    """Constant-time check that `presented` is this task's hook token."""
    if not secret or not presented:
        return False
    return hmac.compare_digest(presented, scoped_token(secret, user_id, task_id))
