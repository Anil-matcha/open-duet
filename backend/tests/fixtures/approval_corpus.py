"""The labeled dangerous-command corpus the explain projection is checked against.

Every entry carries its source so the projection's verdict can be traced back to
the place the expectation comes from. Two sources feed it:

- `certification` — a program the allowlist certifies safe to always allow (from
  `tests/services/test_approval_allowlist.py::_PREFIX_SAFE_REVIEW`), with its
  floor verdict. These are the commands a prefix rule can legitimately sweep in.
- `floor` — a wrapper/value-option/runner case from
  `tests/services/test_safety_floor.py` that must stay on the never-list.

The corpus is deliberately small (≈ 30–40 entries): every entry is maintenance
surface, and the certification tests own the allowlist-accurate entries. The
`test_approval_corpus.py` consistency check keeps the overlapping subset in step
with the certification records.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CorpusEntry:
    command: str
    floor_clear: bool  # True only for a command that was read and matched nothing
    floor_rule: str | None  # the never-list rule when floor_clear is False
    source: str  # where the expectation comes from


# --- wrapper / value-option / runner cases (the audit's ISSUE-11 surface) ------
# These are the commands a naive prefix matcher would mis-read. A projection that
# re-implements resolution instead of reusing the floor's would diverge here.
_WRAPPER_CASES = [
    ("env -S 'rm -rf ~'", False, "delete-home", "audit ISSUE-11 / test_safety_floor.py::test_a_wrapper_hiding_the_command_does_not_clear_the_floor"),
    ("env --split-string='rm -rf ~'", False, "delete-home", "test_safety_floor.py::test_a_wrapper_hiding_the_command_does_not_clear_the_floor"),
    ("env -S 'git push --force'", False, "force-push", "test_safety_floor.py::test_a_wrapper_hiding_the_command_does_not_clear_the_floor"),
    ("stdbuf -o L rm -rf ~", False, "delete-home", "test_safety_floor.py::test_a_wrapper_hiding_the_command_does_not_clear_the_floor"),
    ("nohup -p rm -rf ~", False, "delete-home", "test_safety_floor.py::test_a_wrapper_hiding_the_command_does_not_clear_the_floor"),
    ("nice -n 5 rm -rf /", False, "delete-root", "test_safety_floor.py::test_a_wrapper_hiding_the_command_does_not_clear_the_floor"),
    ("sudo -u root rm -rf /", False, "delete-root", "audit ISSUE-11 / test_safety_floor.py::test_a_wrapper_hiding_the_command_does_not_clear_the_floor"),
    ("find / -exec rm -rf {} +", False, "delete-root", "test_safety_floor.py::test_a_wrapper_hiding_the_command_does_not_clear_the_floor"),
    ("xargs rm -rf ~", False, "delete-home", "test_safety_floor.py::test_a_wrapper_hiding_the_command_does_not_clear_the_floor"),
    ("xargs -0 rm -rf /", False, "delete-root", "test_safety_floor.py::test_a_wrapper_hiding_the_command_does_not_clear_the_floor"),
    ("flock /tmp/l rm -rf ~", False, "delete-home", "audit ISSUE-11 / test_safety_floor.py::test_a_runner_hiding_the_command_does_not_clear_the_floor"),
    ("flock -w 5 /tmp/l rm -rf /etc", False, "delete-system-directory", "test_safety_floor.py::test_a_runner_hiding_the_command_does_not_clear_the_floor"),
    ("chroot / rm -rf /", False, "delete-root", "audit ISSUE-11 / test_safety_floor.py::test_a_runner_hiding_the_command_does_not_clear_the_floor"),
    ("busybox rm -rf /", False, "delete-root", "audit ISSUE-11 / test_safety_floor.py::test_a_runner_hiding_the_command_does_not_clear_the_floor"),
    ("busybox chmod -R 777 /etc", False, "permission-change-root", "test_safety_floor.py::test_a_runner_hiding_the_command_does_not_clear_the_floor"),
    ("unshare -r rm -rf /", False, "delete-root", "audit ISSUE-11 / test_safety_floor.py::test_a_runner_hiding_the_command_does_not_clear_the_floor"),
    ("nsenter -t 1 -m rm -rf /", False, "delete-root", "test_safety_floor.py::test_a_runner_hiding_the_command_does_not_clear_the_floor"),
    ("busybox sh -c 'rm -rf /'", False, "delete-root", "test_safety_floor.py::test_a_runner_hiding_the_command_does_not_clear_the_floor"),
    ("git push --force", False, "force-push", "test_safety_floor.py / test_approval_allowlist.py::test_credentials_control_characters_and_floor_commands_cannot_be_saved"),
    ("rm -rf /", False, "delete-root", "test_safety_floor.py / test_approval_allowlist.py::test_credentials_control_characters_and_floor_commands_cannot_be_saved"),
]

# --- commands a saved prefix rule legitimately sweeps in (cleared) ------------
# Their programs are certified prefix-safe in
# test_approval_allowlist.py::_PREFIX_SAFE_REVIEW.
_CLEARED_CASES = [
    ("ls -la", "test_approval_allowlist.py::_PREFIX_SAFE_REVIEW[ls]"),
    ("cat notes.txt", "test_approval_allowlist.py::_PREFIX_SAFE_REVIEW[cat]"),
    ("grep -n TODO notes.txt", "test_approval_allowlist.py::_PREFIX_SAFE_REVIEW[grep]"),
    ("head -5 notes.txt", "test_approval_allowlist.py::_PREFIX_SAFE_REVIEW[head]"),
    ("tail -5 notes.txt", "test_approval_allowlist.py::_PREFIX_SAFE_REVIEW[tail]"),
    ("wc -l notes.txt", "test_approval_allowlist.py::_PREFIX_SAFE_REVIEW[wc]"),
    ("stat notes.txt", "test_approval_allowlist.py::_PREFIX_SAFE_REVIEW[stat]"),
    ("readlink notes.link", "test_approval_allowlist.py::_PREFIX_SAFE_REVIEW[readlink]"),
    ("jq .meta package.json", "test_approval_allowlist.py::_PREFIX_SAFE_REVIEW[jq]"),
    ("which node", "test_approval_allowlist.py::_PREFIX_SAFE_REVIEW[which]"),
    ("base64 notes.txt", "test_approval_allowlist.py::_PREFIX_SAFE_REVIEW[base64]"),
    ("sha256sum notes.txt", "test_approval_allowlist.py::_PREFIX_SAFE_REVIEW[sha256sum]"),
]


CORPUS: list[CorpusEntry] = [
    *(CorpusEntry(c, clear, rule, source) for c, clear, rule, source in _WRAPPER_CASES),
    *(CorpusEntry(c, True, None, source) for c, source in _CLEARED_CASES),
]

# The commands a prefix rule could legitimately auto-allow (cleared + prefix-safe
# first word). The `would_allow` engine must return exactly the corpus members a
# rule's matcher accepts among these.
CLEARED: list[CorpusEntry] = [e for e in CORPUS if e.floor_clear]
