"""Read-only projection of what the enforcement machinery will do with a command.

At decision time (an approval card) and at rule-save time (preview), the owner
should see the consequence, not reason about argv semantics: the argv after
wrapper/value-option resolution, the saved rule that matches, the safety-floor
verdict, and the other commands the same rule would also allow.

The projection reuses `safety_floor` and `approval_allowlist` directly — it never
re-implements parsing, because the parity property (the projection equals what
enforcement does) is exactly what breaks when two copies drift.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.db.models import Approval
from app.services import approval_allowlist as allowlist
from app.services import safety_floor


@dataclass(frozen=True)
class MatchedRule:
    id: int
    kind: str  # "prefix" | "exact"
    command: str
    workspace: str | None

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "command": self.command,
            "workspace": self.workspace,
        }


def _rule_summary(rule) -> MatchedRule:
    kind, workspace = allowlist.split_scope(rule.connector or "")
    return MatchedRule(id=rule.id, kind=kind, command=rule.tool, workspace=workspace)


def _floor_verdict(command: str) -> dict:
    reading = safety_floor.floor_reading(command)
    if reading.verdict is not None:
        return {
            "clear": False,
            "tripped_check": reading.verdict.rule,
            "reason": reading.verdict.label,
            "skipped_reason": None,
        }
    if not reading.readable:
        # Unreadable is not clear and not a named rule: it is held, not allowed.
        return {
            "clear": False,
            "tripped_check": None,
            "reason": None,
            "skipped_reason": "the command could not be read to the end and is held for a person",
        }
    return {"clear": True, "tripped_check": None, "reason": None, "skipped_reason": None}


def would_allow(rule: MatchedRule | object, corpus) -> list[str]:
    """The corpus commands this rule would auto-allow.

    A command is auto-allowed by a rule only when the rule matches it *and* the
    floor clears it — the same two conditions `matching_rule` enforces at decision
    time. `rule` may be a `MatchedRule` or a saved `PermissionRule`."""
    if isinstance(rule, MatchedRule):
        kind, command, workspace = rule.kind, rule.command, rule.workspace
    else:
        kind, workspace = allowlist.split_scope(rule.connector or "")
        command = rule.tool
    allowed: list[str] = []
    for entry in corpus:
        if not entry.floor_clear:
            continue  # a floor command is never auto-allowed, whatever the rule
        if _matches(kind, command, workspace, entry.command, None):
            allowed.append(entry.command)
    return allowed


def _matches(kind: str, rule_command: str, workspace: str | None, command: str, at_workspace: str | None) -> bool:
    """`command_matches` plus rule-scope: a workspace-bound rule only sweeps its
    own workspace."""
    if workspace is not None and workspace != at_workspace:
        return False
    return allowlist.command_matches(kind, rule_command, command)


def explain_command(
    command: str,
    *,
    workspace: str | None = None,
    rule: MatchedRule | None = None,
    corpus=None,
) -> dict:
    """The structured explanation for one command under an optional matched rule."""
    if corpus is None:
        from tests.fixtures.approval_corpus import CORPUS  # type: ignore[import-not-found]

        corpus = CORPUS
    resolution = safety_floor.resolution(command)
    also = [] if rule is None else would_allow(rule, corpus)
    return {
        "command": command,
        "resolved_argv": resolution.argv,
        "wrapper_chain": resolution.wrapper_chain,
        "value_options_resolved": [list(pair) for pair in resolution.value_options_resolved],
        "matched_rule": rule.as_dict() if rule is not None else None,
        "floor_verdict": _floor_verdict(command),
        "also_allows": also,
    }


def explain_approval(approval: Approval, rule: MatchedRule | None, corpus=None) -> dict:
    """Explain a pending approval: its Bash command under the rule that matched."""
    tool_input = approval.input if isinstance(approval.input, dict) else {}
    command = tool_input.get("command")
    if not isinstance(command, str):
        command = ""
    return explain_command(command, rule=rule, corpus=corpus)


def preview_rule(kind: str, command: str, workspace: str | None, corpus=None) -> dict:
    """Dry-run a candidate rule: what it would allow, reject, and the floor state.

    Validates exactly as the save path does (same `InvalidRule` message), so a
    payload that would be refused on save is refused here too."""
    if corpus is None:
        from tests.fixtures.approval_corpus import CORPUS  # type: ignore[import-not-found]

        corpus = CORPUS
    allowlist.validate_rule(kind, command, workspace)
    candidate = MatchedRule(id=0, kind=kind, command=command.strip(), workspace=workspace)
    allowed = set(would_allow(candidate, corpus))
    would_reject = [e.command for e in corpus if e.command not in allowed]
    # The floor state of the candidate itself: a floor command cannot be saved at
    # all, so a valid candidate always clears — reported for the card's honesty.
    floor = _floor_verdict(command)
    return {
        "would_allow": [e.command for e in corpus if e.command in allowed],
        "would_reject": would_reject,
        "floor_state": floor,
    }
