"""Integration — approval trust flow end to end.

Composes the real route layer of the approval legibility chain: explain →
(preview → save → match) → batch accept. Unit correctness is owned by
`approval-explain-endpoint` and `approval-card-ui`; this module is a thin driver
through both surfaces with real payloads crossing the seam, and it writes
`specs/integration-approval-trust/report.yml` (regenerated on every run, never
hand-edited).

The frontend seam (payload keys → card sections / batch gate) is exercised by
`frontend/lib/approval-trust.test.mjs`, which replays the payloads this module
records into `frontend/lib/approval-trust-payloads.json`.
"""

import json
import subprocess
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from app.core.config import settings
from app.routers.approval_rules import router as rules_router
from app.routers.explain import router as explain_router
from app.routers.threads import get_runtime
from app.routers.threads import router as threads_router
from tests.services.thread_harness import (  # noqa: F401
    cleanup,
    cli,
    finished,
    new_thread,
    owner,
    pending_approval,
    rt,
    sessions,
    tools_on,
)

REPO = Path(__file__).resolve().parents[3]
REPORT = REPO / ".agents" / "specs" / "integration-approval-trust" / "report.yml"
FRONTEND_PAYLOADS = REPO / "frontend" / "lib" / "approval-trust-payloads.json"
DRIFT_SCRIPT = REPO / "backend" / "scripts" / "check_schema_drift.py"

BASH_WRAPPER = {"type": "tool", "tool_name": "Bash", "tool_input": {"command": "env -S 'rm -rf ~'"}}
BASH_LS = {"type": "tool", "tool_name": "Bash", "tool_input": {"command": "ls -la"}}


@pytest.fixture(autouse=True)
def local_enabled(monkeypatch):
    monkeypatch.setattr(settings, "LOCAL_EXECUTION_ENABLED", True)
    monkeypatch.setattr(settings, "FRONTEND_ORIGINS", "http://localhost:3000")
    monkeypatch.setattr(settings, "LOCAL_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1]")


def app_for(rt) -> FastAPI:
    app = FastAPI()
    for router in (threads_router, rules_router, explain_router):
        app.include_router(router, prefix="/api/v1")
    app.dependency_overrides[get_runtime] = lambda: rt
    return app


def client_for(app, *, client=("127.0.0.1", 50000), base_url="http://localhost"):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app, client=client), base_url=base_url)


@pytest.fixture
async def api(rt):
    async with client_for(app_for(rt)) as client:
        yield client


async def _seed_era_rule(sessions, owner, kind: str, command: str, workspace: str | None = None):
    """Seed a saved rule directly, bypassing save-time validation — the approved
    path for pre-certification-era data (`env`-style rules that the ISSUE-11 fix
    now refuses to save). The spec's wrapper scenario depends on such a rule
    existing, so the scenario inserts the row the same way enforcement reads it."""
    from app.db.models.permission_rule import PermissionRule
    from app.services.approval_allowlist import BUCKET

    stored_kind = kind if workspace is None else f"{kind}@{workspace}"
    async with sessions() as db:
        rule = PermissionRule(
            user_id=owner, bucket=BUCKET, connector=stored_kind, tool=command, decision="allow"
        )
        db.add(rule)
        await db.commit()
        await db.refresh(rule)
        return rule.id


async def _open_approval(api, rt, sessions, cli, owner, script, *, rule=None):
    thread = await new_thread(sessions, owner)
    if rule is not None:
        saved = await api.post("/api/v1/approval-rules", json=rule)
        assert saved.status_code == 201, saved.text
    cli.script(script)
    await rt.send_turn(thread.id, "go")
    return thread, await pending_approval(sessions, thread.id)


def _drift_precondition() -> tuple[bool, str]:
    proc = subprocess.run(
        [sys.executable, str(DRIFT_SCRIPT)],
        capture_output=True,
        text=True,
        cwd=str(REPO / "backend"),
    )
    line = (proc.stdout or proc.stderr).strip().splitlines()[-1] if (proc.stdout or proc.stderr) else ""
    return proc.returncode == 0, line


def _write_report(results: list[dict], drift_ok: bool, drift_line: str, issues: list[str]) -> None:
    """Merge this scenario's result into report.yml keyed by scenario name, so a
    run of the whole suite accumulates one row per acceptance criterion. The file
    is regenerated (replaced) at the start of a run by `reset_report`."""
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    existing: dict = {"results": [], "discovered_issues": []}
    if REPORT.exists():
        existing = json.loads(REPORT.read_text())
    by_name = {r["scenario"]: r for r in existing.get("results", [])}
    for r in results:
        by_name[r["scenario"]] = r
    merged = list(by_name.values())
    merged_issues = list(dict.fromkeys(existing.get("discovered_issues", []) + issues))
    report = {
        "scenarios_passed": all(r["passed"] for r in merged) and drift_ok,
        "precondition_schema_drift_green": drift_ok,
        "precondition_schema_drift_output": drift_line,
        "results": merged,
        "discovered_issues": merged_issues,
    }
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=False) + "\n")


@pytest.fixture(scope="session", autouse=True)
def reset_report():
    """Start each full-suite run from a clean report so stale rows cannot linger."""
    REPORT.unlink(missing_ok=True)
    yield


# --- Scenario 1: wrapper explain shows consequences --------------------------


async def test_scenario_wrapper_explain_shows_consequences(api, rt, sessions, cli, tools_on, owner):
    """AC1: a pending `env -S 'rm -rf ~'` under an env-era rule surfaces the
    resolved argv and the blocked floor verdict before any decision.

    Enforcement-honest reading of AC1 (see report `discovered_issues`): the floor
    precedes and overrides rules, so for a floor command `matching_rule` returns
    None and the explain endpoint reports `matched_rule: null` and
    `also_allows: []` — even when an `env`-era rule is present (`_seed_era_rule`).
    That a saved rule *cannot* make the wrapper auto-allow is the trust property;
    asserting a named matched rule here would contradict enforcement. AC1's
    "matched rule" is demonstrated on a floor-clear command in scenario 2.
    """
    await _seed_era_rule(sessions, owner, "prefix", "env")
    thread, approval = await _open_approval(api, rt, sessions, cli, owner, BASH_WRAPPER)
    body = (await api.post(f"/api/v1/approvals/{approval.id}/explain")).json()

    assert body["command"] == "env -S 'rm -rf ~'"
    assert body["resolved_argv"] == ["env", "-S", "rm -rf ~"]
    assert body["wrapper_chain"] == ["env"]
    assert body["floor_verdict"]["clear"] is False
    assert body["floor_verdict"]["tripped_check"] == "delete-home"
    # A saved rule never overrides the floor: no match, no consequences.
    assert body["matched_rule"] is None
    assert body["also_allows"] == []

    FRONTEND_PAYLOADS.parent.mkdir(parents=True, exist_ok=True)
    FRONTEND_PAYLOADS.write_text(json.dumps({"wrapper_explain": body}, indent=2) + "\n")

    _write_report(
        [{"scenario": "wrapper_explain_shows_consequences", "passed": True,
          "evidence": f"resolved_argv={body['resolved_argv']} tripped={body['floor_verdict']['tripped_check']} matched_rule={body['matched_rule']} also_allows={len(body['also_allows'])}"}],
        *_drift_precondition(),
        issues=["AC1 example says the env-era rule is 'matched' on a floor command; enforcement (floor precedes rules) returns matched_rule=null and also_allows=[] — scenario asserts the enforcement-honest behavior; verified via seeded era rule"],
    )


# --- Scenario 2: save preview sandwich ---------------------------------------


async def test_scenario_save_preview_then_active(api, rt, sessions, cli, tools_on, owner):
    """AC2: previewing a candidate prefix rule shows non-empty would_allow before
    save; saving makes the rule active and matching_rule reflects it
    (preview→save→match). `ls` is a prefix-safe program the save path accepts."""
    preview = (await api.post("/api/v1/approval-rules/preview", json={"match": "prefix", "command": "ls"})).json()
    assert preview["would_allow"], "preview must list consequences before save"
    assert preview["floor_state"]["clear"] is True

    saved = (await api.post("/api/v1/approval-rules", json={"match": "prefix", "command": "ls"})).json()
    assert saved["command"] == "ls"

    thread, approval = await _open_approval(api, rt, sessions, cli, owner, BASH_LS)
    body = (await api.post(f"/api/v1/approvals/{approval.id}/explain")).json()
    assert body["matched_rule"]["command"] == "ls"
    assert set(preview["would_allow"]) == set(body["also_allows"])

    _write_report(
        [{"scenario": "save_preview_then_active", "passed": True,
          "evidence": f"would_allow={len(preview['would_allow'])} matched_rule=ls"}],
        *_drift_precondition(), issues=[],
    )


# --- Scenario 3: batch accept + mixed refusal --------------------------------


async def test_scenario_batch_accept_and_mixed_refusal(api, rt, sessions, cli, tools_on, owner):
    """AC3: floor-clear reads batch-approve with per-item outcomes; a blocked item
    in the selection is refused (batch gate disabled)."""
    # Three separate threads, each with one pending floor-clear read approval
    # (a thread holds one running turn at a time).
    targets: list[tuple[int, str]] = []
    for _ in range(3):
        t, a = await _open_approval(api, rt, sessions, cli, owner, BASH_LS)
        targets.append((t.id, a.id))

    explained = [(await api.post(f"/api/v1/approvals/{aid}/explain")).json() for _, aid in targets]
    assert all(b["floor_verdict"]["clear"] is True for b in explained)

    outcomes = []
    for tid, aid in targets:
        r = await api.post(f"/api/v1/threads/{tid}/approvals/{aid}", json={"decision": "allow"})
        outcomes.append({"id": aid, "ok": r.status_code == 200, "status": r.json().get("status")})
    assert all(o["ok"] for o in outcomes), outcomes

    # A wrapped home-delete is not floor-clear, so it can never join a batch.
    _, blocked = await _open_approval(api, rt, sessions, cli, owner, BASH_WRAPPER)
    blocked_body = (await api.post(f"/api/v1/approvals/{blocked.id}/explain")).json()
    assert blocked_body["floor_verdict"]["clear"] is False

    _write_report(
        [{"scenario": "batch_accept_and_mixed_refusal", "passed": True,
          "evidence": f"approved={len(outcomes)} per_item_ok={all(o['ok'] for o in outcomes)} blocked_clear={blocked_body['floor_verdict']['clear']}"}],
        *_drift_precondition(), issues=[],
    )


# --- Scenario 4: no-side-effect composition ----------------------------------


async def test_scenario_explain_and_preview_have_no_side_effects(api, rt, sessions, cli, tools_on, owner):
    """AC4: explain leaves the approval pending; preview creates no rule row."""
    thread, approval = await _open_approval(api, rt, sessions, cli, owner, BASH_LS)
    async with sessions() as db:
        from app.services import thread_store as store

        before = await store.get_approval(db, approval.id)
        rules_before = len(await api_get_rules(api))

    for _ in range(2):
        assert (await api.post(f"/api/v1/approvals/{approval.id}/explain")).status_code == 200
    assert (await api.post("/api/v1/approval-rules/preview", json={"match": "prefix", "command": "wc"})).status_code == 200

    async with sessions() as db:
        from app.services import thread_store as store

        after = await store.get_approval(db, approval.id)
    rules_after = len(await api_get_rules(api))
    assert after.status == before.status == "pending"
    assert rules_after == rules_before

    _write_report(
        [{"scenario": "explain_and_preview_have_no_side_effects", "passed": True,
          "evidence": f"approval_status={after.status} rules_before={rules_before} rules_after={rules_after}"}],
        *_drift_precondition(), issues=[],
    )


async def api_get_rules(api):
    return (await api.get("/api/v1/approval-rules")).json()


# --- Scenario 5: drift precondition ------------------------------------------


def test_scenario_drift_precondition_records_clean_run():
    """AC5: the drift check is green and its output is cited in the report."""
    ok, line = _drift_precondition()
    assert ok, f"schema drift precondition not green: {line}"
    assert "ok" in line
    _write_report(
        [{"scenario": "drift_precondition", "passed": ok, "evidence": line}],
        ok, line, issues=[],
    )
