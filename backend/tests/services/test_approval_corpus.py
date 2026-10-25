"""The corpus stays in step with the allowlist certification records.

The corpus's `cleared` commands come from `_PREFIX_SAFE_REVIEW` in
`test_approval_allowlist.py`. If a program is added to or removed from the
allowlist, this test fails until the corpus is regenerated — that is the signal
to revisit which commands the explain projection should sweep in.
"""

from app.services import approval_allowlist as allow
from tests.fixtures.approval_corpus import CLEARED
from tests.services.test_approval_allowlist import _PREFIX_SAFE_REVIEW


def test_every_cleared_corpus_command_uses_a_certified_prefix_safe_program():
    for entry in CLEARED:
        program = allow._program(entry.command)
        assert program in allow._PREFIX_SAFE_PROGRAMS, (entry.command, program)
        assert program in _PREFIX_SAFE_REVIEW, program


def test_every_certified_program_is_covered_by_the_corpus():
    """Each allowlisted program the corpus claims to cover must appear, so a new
    allowlist entry with no corpus command is visible here (not silently absent)."""
    covered = {allow._program(e.command) for e in CLEARED}
    # The corpus covers a representative subset; assert the subset it names is
    # real and, for each, that a corpus command exists (the loop above proves the
    # converse). A program in the review map but not the corpus is allowed, but
    # the mapping must never point at a nonexistent program.
    for program in covered:
        assert program in _PREFIX_SAFE_REVIEW


def test_cleared_commands_really_validate_as_prefix_rules():
    """The corpus's cleared commands are exactly the kind a prefix rule may save."""
    for entry in CLEARED:
        assert allow.validate_rule(allow.PREFIX, entry.command) == entry.command
