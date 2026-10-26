"""Extension points for a hosted deployment that signs many people in.

The open server knows one owner. A deployment that wraps it (accounts, tenants) plugs in here
instead of editing the auth middleware: a resolver that turns a request into a Principal, and
extra public routes such as sign-up. With nothing registered the behavior is unchanged.
"""

import re
from collections.abc import Awaitable, Callable

from starlette.types import Scope

from app.auth import policy

# Returns the Principal for a request, or None when it carries no credential this resolver
# understands. It must do its own CSRF check for cookie sessions; the middleware does not.
PrincipalResolver = Callable[[Scope], Awaitable[policy.Principal | None]]

_resolver: PrincipalResolver | None = None


def register_principal_resolver(resolver: PrincipalResolver | None) -> None:
    global _resolver
    _resolver = resolver


def principal_resolver() -> PrincipalResolver | None:
    return _resolver


def register_public_route(methods: set[str], path_pattern: str) -> None:
    """Allow `methods` on paths matching the regex (full match, including the /api/v1 prefix)
    without a session. Host and Origin checks still apply."""
    policy.PUBLIC_ROUTES += ((frozenset(methods), re.compile(f"^{path_pattern}$")),)
