"""The parity property: the explain projection equals what enforcement does.

This is the load-bearing acceptance criterion. For every corpus command the
projection's floor verdict must equal the real `safety_floor` outcome, and a
rule's `would_allow` set must equal the corpus commands the matcher would really
auto-allow. A projection that disagrees with enforcement is worse than none.
"""

import pytest

from app.services import approval_allowlist as allowlist
from app.services import approval_explain as explain
from app.services import safety_floor
from tests.fixtures.approval_corpus import CLEARED, CORPUS


def test_every_corpus_entry_carries_its_source():
    """AC6: provenance — every entry has a source tag, no heuristic generation."""
    for entry in CORPUS:
        assert entry.source, entry.command
        assert entry.source.startswith(("test_", "audit")), entry.source


def test_the_corpus_expectations_match_the_safety_floor():
    """The corpus is labeled from the floor's truth, not the other way round."""
    for entry in CORPUS:
        reading = safety_floor.floor_reading(entry.command)
        assert reading.clear == entry.floor_clear, (entry.command, reading)
        got_rule = reading.verdict.rule if reading.verdict else None
        assert got_rule == entry.floor_rule, (entry.command, got_rule, entry.floor_rule)


def test_explain_floor_verdict_equals_enforcement_for_every_command():
    """AC2: full-corpus sweep, no sampling."""
    for entry in CORPUS:
        body = explain.explain_command(entry.command, corpus=CORPUS)
        reading = safety_floor.floor_reading(entry.command)
        assert body["floor_verdict"]["clear"] == reading.clear, entry.command
        if reading.verdict is not None:
            assert body["floor_verdict"]["tripped_check"] == reading.verdict.rule, entry.command
            assert body["floor_verdict"]["reason"] == reading.verdict.label, entry.command
        else:
            assert body["floor_verdict"]["tripped_check"] is None, entry.command


def test_would_allow_equals_the_matcher_for_every_prefix_rule():
    """AC2: `also_allows` equals the exact auto-allow set, per candidate rule."""
    # One prefix rule per certified prefix-safe program in the corpus, plus an
    # exact rule, is enough to exercise the matcher over the whole corpus.
    candidates = [
        ("prefix", "ls"),
        ("prefix", "cat"),
        ("prefix", "grep"),
        ("prefix", "flock"),
        ("prefix", "env"),
        ("priority", "git push --force"),
        ("exact", "rm -rf /"),
        ("exact", "ls -la"),
    ]
    for kind, command in candidates:
        rule = explain.MatchedRule(id=1, kind=kind, command=command, workspace=None)
        got = sorted(explain.would_allow(rule, CORPUS))
        want = sorted(
            e.command
            for e in CORPUS
            if e.floor_clear and allowlist.command_matches(kind, command, e.command)
        )
        assert got == want, (kind, command, got, want)


def test_a_workspace_scoped_rule_does_not_sweep_other_workspaces():
    rule = explain.MatchedRule(id=1, kind="prefix", command="ls", workspace="/work/a")
    assert explain.would_allow(rule, CORPUS) == []
    same = explain.MatchedRule(id=1, kind="prefix", command="ls", workspace="/work/a")
    assert explain.would_allow(same, CORPUS) == []


def test_preview_equals_a_saved_rule_matched_over_the_corpus():
    """AC5: preview(cmd,kind,workspace) equals the post-save matcher result."""
    for kind, command in [("prefix", "ls"), ("prefix", "grep"), ("exact", "ls -la")]:
        preview = explain.preview_rule(kind, command, None, corpus=CORPUS)
        rule = explain.MatchedRule(id=1, kind=kind, command=command.strip(), workspace=None)
        assert preview["would_allow"] == explain.would_allow(rule, CORPUS)
        # And every rejected command is genuinely not auto-allowed by the rule.
        for rejected in preview["would_reject"]:
            assert rejected not in preview["would_allow"]


def test_preview_validates_like_the_save_path():
    """A payload the save path refuses is refused here with the same message."""
    with pytest.raises(allowlist.InvalidRule):
        explain.preview_rule("prefix", "rm -rf /", None, corpus=CORPUS)
    with pytest.raises(allowlist.InvalidRule):
        explain.preview_rule("regex", "ls", None, corpus=CORPUS)


def test_floor_commands_are_never_in_any_would_allow():
    """A rule never allows a floor command, whatever its program is."""
    for kind, command in [("prefix", "env"), ("prefix", "flock"), ("exact", "rm -rf /")]:
        rule = explain.MatchedRule(id=1, kind=kind, command=command, workspace=None)
        allowed = set(explain.would_allow(rule, CORPUS))
        floor_commands = {e.command for e in CORPUS if not e.floor_clear}
        assert allowed & floor_commands == set(), (kind, command)


def test_cleared_corpus_set_is_exactly_the_floor_clear_entries():
    assert {e.command for e in CLEARED} == {e.command for e in CORPUS if e.floor_clear}
