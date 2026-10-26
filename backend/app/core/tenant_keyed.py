"""A dict for in-memory registries that are keyed by database ids.

Two accounts have rows with the same ids (thread 5 exists in both schemas), so a registry shared
by the whole process (live event streams, running turns) must not mix them. Keys are paired with
the current account (None outside any account, so the single-owner server behaves exactly like
a plain dict). Iteration helpers see the current account's entries; `all_values` sees every
account's, for shutdown.
"""

from collections.abc import Iterator
from typing import Generic, TypeVar

from app.db import tenant_schema

K = TypeVar("K")
V = TypeVar("V")

_MISSING = object()


class TenantMap(Generic[K, V]):
    def __init__(self) -> None:
        self._items: dict[tuple[str | None, K], V] = {}

    @staticmethod
    def _key(key: K) -> tuple[str | None, K]:
        return (tenant_schema.current_schema(), key)

    def __getitem__(self, key: K) -> V:
        return self._items[self._key(key)]

    def __setitem__(self, key: K, value: V) -> None:
        self._items[self._key(key)] = value

    def __contains__(self, key: object) -> bool:
        return self._key(key) in self._items  # type: ignore[arg-type]

    def get(self, key: K, default=None):
        return self._items.get(self._key(key), default)

    def setdefault(self, key: K, default: V) -> V:
        return self._items.setdefault(self._key(key), default)

    def pop(self, key: K, default=_MISSING):
        if default is _MISSING:
            return self._items.pop(self._key(key))
        return self._items.pop(self._key(key), default)

    def values(self) -> Iterator[V]:
        schema = tenant_schema.current_schema()
        return iter([v for (s, _k), v in list(self._items.items()) if s == schema])

    def all_values(self) -> list[V]:
        return list(self._items.values())

    def __len__(self) -> int:
        return len(self._items)

    def _current(self) -> dict:
        schema = tenant_schema.current_schema()
        return {k: v for (s, k), v in list(self._items.items()) if s == schema}

    def items(self):
        return self._current().items()

    def __iter__(self):
        return iter(self._current())

    def __eq__(self, other: object) -> bool:
        # Equal to a plain dict holding the current account's entries, like the dict it replaces.
        return self._current() == (other._current() if isinstance(other, TenantMap) else other)

    __hash__ = None  # type: ignore[assignment]
