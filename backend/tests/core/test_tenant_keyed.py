from app.core.tenant_keyed import TenantMap
from app.db import tenant_schema

ACCOUNT = "u_" + "a" * 32


def test_clear_and_keys_cover_the_current_account_only():
    registry: TenantMap[int, str] = TenantMap()
    registry[1] = "owner"
    with tenant_schema.use_tenant(ACCOUNT):
        registry[1] = "account"
        assert list(registry.keys()) == [1]
        registry.clear()
        assert 1 not in registry
    assert registry[1] == "owner"
    registry.clear()
    assert len(registry) == 0
