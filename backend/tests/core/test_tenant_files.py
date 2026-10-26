"""Hosted accounts keep their files and in-memory registries apart (no database needed)."""

import os
from pathlib import Path

import pytest

from app.core import tenant_paths
from app.core.config import settings
from app.core.tenant_keyed import TenantMap
from app.db import tenant_schema
from app.services import attachments, decision_log, memory_journal, workspace_files, workspaces
from app.services.thread_hub import ThreadHub

A = "u_" + "a" * 32
B = "u_" + "b" * 32


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "TENANT_DATA_DIR", str(tmp_path / "tenants"))
    return tmp_path


def test_outside_any_account_nothing_changes():
    assert tenant_paths.root() is None
    assert tenant_paths.contains("/anywhere")
    assert attachments.root_dir() == Path.home() / ".open-dots" / "attachments" or settings.ATTACHMENTS_DIR


def test_every_per_account_location_is_under_that_accounts_folder(data_dir):
    with tenant_schema.use_tenant(A):
        mine = tenant_paths.root()
        assert mine == (data_dir / "tenants" / ("a" * 32)).resolve()
        for path in (attachments.root_dir(), decision_log.log_dir(), memory_journal.state_root(),
                     workspaces.canonical_workspace()):
            assert mine in path.resolve().parents
    with tenant_schema.use_tenant(B):
        assert tenant_paths.root() != mine


def test_an_account_cannot_choose_a_host_folder_for_its_workspace(data_dir):
    with tenant_schema.use_tenant(A):
        chosen = workspaces.canonical_workspace("/etc")
        assert chosen == (tenant_paths.root() / "workspace").resolve()


def test_paths_of_other_accounts_and_escapes_are_outside(data_dir):
    with tenant_schema.use_tenant(A):
        mine = tenant_paths.root()
        theirs = tenant_paths.root_of(B)
        mine.mkdir(parents=True)
        theirs.mkdir(parents=True)
        (mine / "ok").mkdir()
        assert tenant_paths.contains(mine / "ok")
        assert not tenant_paths.contains(theirs)
        assert not tenant_paths.contains(mine / ".." / ("b" * 32))
        os.symlink(theirs, mine / "link")  # a link to another account is followed, then refused
        assert not tenant_paths.contains(mine / "link")


def test_workspace_listing_refuses_another_accounts_folder(data_dir):
    theirs = tenant_paths.root_of(B)
    (theirs / "workspace").mkdir(parents=True)
    with tenant_schema.use_tenant(A):
        with pytest.raises(workspace_files.FileAccessError):
            workspace_files.canonical_root(str(theirs / "workspace"))


@pytest.mark.parametrize("bad", ["u_x", "../etc", "u_" + "A" * 32, ""])
def test_account_names_can_never_be_paths(bad):
    with pytest.raises(ValueError):
        tenant_paths.root_of(bad)


def test_removing_an_account_deletes_only_its_folder(data_dir):
    for tenant in (A, B):
        (tenant_paths.root_of(tenant) / "workspace").mkdir(parents=True)
    tenant_paths.remove(A)
    assert not tenant_paths.root_of(A).exists() and tenant_paths.root_of(B).exists()


def test_tenant_map_keeps_equal_ids_apart_and_acts_like_a_dict_outside_accounts():
    registry: TenantMap[int, str] = TenantMap()
    registry[5] = "owner"
    with tenant_schema.use_tenant(A):
        assert registry.get(5) is None
        registry[5] = "a"
    with tenant_schema.use_tenant(B):
        assert 5 not in registry
        registry[5] = "b"
        assert list(registry.values()) == ["b"]
    assert registry[5] == "owner" and sorted(registry.all_values()) == ["a", "b", "owner"]
    with tenant_schema.use_tenant(A):
        assert registry.pop(5) == "a"
    assert registry.pop(5, None) == "owner" and registry.pop(5, None) is None


def test_a_live_stream_in_one_account_never_hears_another_accounts_thread():
    hub = ThreadHub()
    with tenant_schema.use_tenant(A):
        listener = hub.subscribe(7)
    with tenant_schema.use_tenant(B):
        hub.notify(7)
        hub.delta(7, 1, "secret of B")
    assert not listener.wake.is_set() and listener.deltas.empty()
    with tenant_schema.use_tenant(A):
        hub.notify(7)
    assert listener.wake.is_set()
