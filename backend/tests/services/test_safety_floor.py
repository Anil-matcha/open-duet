import pytest

from app.services.safety_floor import clears_floor, floor_reading


def rule_of(command):
    reading = floor_reading(command)
    assert reading.readable, command
    return reading.verdict.rule if reading.verdict else None


@pytest.mark.parametrize(
    "command,rule",
    [
        ("rm -rf /", "delete-root"),
        ("rm -rf /*", "delete-root"),
        ("rm -Rf //", "delete-root"),
        ("rm -rf /usr/../", "delete-root"),
        ("rm --recursive --force /", "delete-root"),
        ("sudo rm -fr ~", "delete-home"),
        ("rm -rf $HOME/", "delete-home"),
        ("rm -rf ${HOME}/*", "delete-home"),
        ("rm -r ~/.", "delete-home"),
        ("rm -r /etc", "delete-system-directory"),
        ("rm -rf /usr/", "delete-system-directory"),
        ("rm -rf /Users", "delete-system-directory"),
        ("timeout 5 rm -rf /", "delete-root"),
        ("env FOO=1 nohup rm -rf /", "delete-root"),
        ("ls && rm -rf /", "delete-root"),
        ("ls; rm -rf /etc", "delete-system-directory"),
        ("bash -c 'rm -rf /'", "delete-root"),
        ("sh -c \"cd x && rm -rf ~\"", "delete-home"),
        ("chmod -R 777 /", "permission-change-root"),
        ("chown -R me ~", "permission-change-root"),
        ("mkfs.ext4 /dev/sda1", "format-disk"),
        ("sudo mkfs -t ext4 /dev/nvme0n1p2", "format-disk"),
        ("wipefs -a /dev/disk2", "format-disk"),
        ("dd if=/dev/zero of=/dev/sda bs=1M", "overwrite-disk"),
        ("echo x > /dev/sda", "overwrite-disk"),
        ("cat img >/dev/nvme0n1", "overwrite-disk"),
        ("shred -n 1 /dev/sdb", "overwrite-disk"),
        ("git push --force", "force-push"),
        ("git push -f origin main", "force-push"),
        ("git push origin main --force-with-lease", "force-push"),
        ("git push origin +main", "force-push"),
        ("git push origin HEAD:+main", "force-push"),
        ("git -C repo push -fu origin x", "force-push"),
        (":(){ :|:& };:", "fork-bomb"),
    ],
)
def test_never_list_commands_are_blocked(command, rule):
    assert rule_of(command) == rule
    assert not clears_floor(command)


@pytest.mark.parametrize(
    "command",
    [
        "ls -la",
        "rm -rf node_modules",
        "rm -rf ./build /tmp/x",
        "rm -r ~/projects/old",
        "rm file.txt",
        "rm -rf /tmp/scratch",
        "git push",
        "git push origin main",
        "git push -u origin feature",
        "git status",
        "git commit -m 'rm -rf /'",
        "echo rm -rf /",
        "echo 'git push --force'",
        "grep -r 'mkfs /dev/sda' docs",
        "chmod -R 755 ./src",
        "chown -R me ./data",
        "dd if=/dev/zero of=./disk.img bs=1M count=10",
        "mkfs.ext4 disk.img",
        "mkfs.ext4 /dev/loop3",
        "echo x > /dev/null",
        "make > build.log 2>&1",
        "cat a | sort | uniq",
    ],
)
def test_ordinary_commands_clear_the_floor(command):
    assert rule_of(command) is None
    assert clears_floor(command)


@pytest.mark.parametrize(
    "command",
    [
        "rm -rf 'unterminated",
        "echo $(whoami)",
        "echo `id`",
        "diff <(ls a) <(ls b)",
        "eval \"$CMD\"",
        "bash -c",
        "bash -c 'echo $(id)'",
    ],
)
def test_a_command_that_cannot_be_read_is_not_clear(command):
    reading = floor_reading(command)
    assert not reading.readable and not reading.clear


def test_a_block_found_before_the_unreadable_part_stands():
    reading = floor_reading("rm -rf / ; echo $(id)")
    assert reading.verdict and reading.verdict.rule == "delete-root"


def test_a_verdict_label_never_holds_the_command():
    reading = floor_reading("rm -rf / # token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz")
    assert "sk-ant" not in reading.verdict.label and "token" not in reading.verdict.label


def test_a_nested_shell_is_read_to_a_limit():
    deep = "echo hi"
    for _ in range(5):
        deep = "sh -c " + __import__("shlex").quote(deep)
    assert not floor_reading(deep).clear


@pytest.mark.parametrize(
    "command,rule",
    [
        ("diskutil eraseDisk JHFS+ Empty /dev/disk2", "format-disk"),
        ("diskutil apfs eraseVolume disk3s1 -name x", "format-disk"),
        ("sudo diskutil zeroDisk disk4", "format-disk"),
        ("diskutil reformat /Volumes/USB", "format-disk"),
        ("dd if=img of=/dev/disk/by-id/usb-Kingston bs=4M", "overwrite-disk"),
        ("cat img > /dev/md/raid0", "overwrite-disk"),
        ("rm -rf /lib*", "delete-system-directory"),
        ("rm -rf /libx32", "delete-system-directory"),
        ("function f { f | f & }; f", "fork-bomb"),
        ("function bomb() { bomb|bomb& }; bomb", "fork-bomb"),
        ("eval 'rm -rf /'", "delete-root"),
        ("eval rm -rf ~", "delete-home"),
    ],
)
def test_more_never_list_commands_are_blocked(command, rule):
    assert rule_of(command) == rule


@pytest.mark.parametrize(
    "command",
    [
        "diskutil list",
        "diskutil info disk2",
        "diskutil eraseVolume APFS x $DISK",
        "dd if=/dev/zero of=/dev/mapper/loop0p1",
        "function greet { echo hi; }; greet",
        "eval 'git status'",
    ],
)
def test_more_ordinary_commands_clear_the_floor(command):
    reading = floor_reading(command)
    # `$DISK` names an unknown device: not blocked, and still readable.
    assert reading.verdict is None


@pytest.mark.parametrize("command", ["$CMD --flag", "bash -c \"$CMD\"", "eval $CMD", "sudo \"$TOOL\" -rf /x"])
def test_a_program_named_by_a_variable_is_not_clear(command):
    reading = floor_reading(command)
    assert not reading.readable and not reading.clear


def test_no_preserve_root_without_recursion_is_read_not_raised():
    # rm without -r cannot delete a directory, but the line must still be read.
    assert floor_reading("rm --no-preserve-root /").verdict.rule == "delete-root"
    assert floor_reading("rm --no-preserve-root ./x").verdict is None


@pytest.mark.parametrize(
    "command",
    [
        "echo hi\nrm -rf ~",
        "echo hi\r\nrm -rf $HOME",
        "ls\ngit push --force origin main",
        "true\n\nmkfs.ext4 /dev/sda1",
    ],
)
def test_a_newline_does_not_hide_a_dangerous_command(command: str) -> None:
    """A newline starts the next command like `;`, it is not a space."""
    assert clears_floor(command) is False


def test_newlines_inside_quotes_and_harmless_lines_still_clear() -> None:
    assert clears_floor("echo 'a\nb'") is True
    assert clears_floor("ls\n") is True
    assert clears_floor("echo hi\n\n\nls -la") is True


@pytest.mark.parametrize(
    "command,rule",
    [
        # A wrapper's value option no longer eats the command after it, and the
        # commands that run another command are read too.
        ("stdbuf -o L rm -rf ~", "delete-home"),
        ("time -p rm -rf ~", "delete-home"),
        ("exec -a x rm -rf ~", "delete-home"),
        ("command -p rm -rf ~", "delete-home"),
        ("nohup -p rm -rf ~", "delete-home"),
        ("nice -n 5 rm -rf /", "delete-root"),
        ("sudo -u root rm -rf /", "delete-root"),
        ("env -S 'rm -rf ~'", "delete-home"),
        ("env --split-string='rm -rf ~'", "delete-home"),
        ("env -S 'git push --force'", "force-push"),
        ("find / -delete", "delete-root"),
        ("find / -exec rm -rf {} +", "delete-root"),
        ("find /etc -exec chmod -R 777 {} +", "permission-change-root"),
        ("xargs rm -rf ~", "delete-home"),
        ("xargs -0 rm -rf /", "delete-root"),
    ],
)
def test_a_wrapper_hiding_the_command_does_not_clear_the_floor(command, rule):
    assert rule_of(command) == rule
    assert not clears_floor(command)


@pytest.mark.parametrize(
    "command",
    [
        "time -p ls",
        "command -p ls",
        "nohup -p ls",
        "nice -n 5 ls",
        "sudo -u root ls",
        "stdbuf -o L echo hi",
        "env FOO=1 ls",
        "xargs echo hi",
        "find . -name x",
        "find . -exec echo {} +",
    ],
)
def test_a_harmless_wrapped_command_still_clears(command):
    assert clears_floor(command) is True


@pytest.mark.parametrize(
    "command,rule",
    [
        ("flock /tmp/l rm -rf ~", "delete-home"),
        ("flock /tmp/l rm -rf /", "delete-root"),
        ("flock -w 5 /tmp/l rm -rf /etc", "delete-system-directory"),
        ("chroot / rm -rf /", "delete-root"),
        ("chroot /newroot rm -rf ~", "delete-home"),
        ("busybox rm -rf /", "delete-root"),
        ("busybox rm -rf ~", "delete-home"),
        ("busybox chmod -R 777 /etc", "permission-change-root"),
        ("strace -f rm -rf /", "delete-root"),
        ("unshare -r rm -rf /", "delete-root"),
        ("unshare --map-root-user rm -rf ~", "delete-home"),
        ("nsenter -t 1 -m rm -rf /", "delete-root"),
        ("su host rm -rf ~", "delete-home"),
        ("runuser -u root -- rm -rf /", "delete-root"),
        ("setpriv --reuid 0 rm -rf /", "delete-root"),
        ("busybox sh -c 'rm -rf /'", "delete-root"),
        ("flock /tmp/l sh -c 'rm -rf /'", "delete-root"),
    ],
)
def test_a_runner_hiding_the_command_does_not_clear_the_floor(command, rule):
    assert rule_of(command) == rule
    assert not clears_floor(command)


@pytest.mark.parametrize(
    "command",
    [
        "python3 -c 'print(1)'",
        "python -c 'import os; os.system(\"rm -rf /\")'",
        "perl -e 'unlink'",
        "node -e 'require(\"fs\")'",
        "ruby -e 'puts 1'",
        "php -r 'echo 1;'",
        "flock -c 'rm -rf /'",
        "su -c 'ls'",
        "su -c 'rm -rf /'",
    ],
)
def test_an_inline_interpreter_script_is_not_clear(command):
    assert not clears_floor(command)


@pytest.mark.parametrize(
    "command",
    [
        "flock /tmp/l make test",
        "flock /tmp/l git status",
        "chroot /newroot ls",
        "busybox echo hi",
        "busybox ls -la",
        "strace -f ls",
        "unshare -r ls",
        "nsenter -t 1 ls",
        "su host ls",
        "runuser -u root -- ls",
        "setpriv --reuid 0 ls",
        "python3 script.py",
        "perl script.pl",
        "node app.js",
    ],
)
def test_a_runner_onto_a_harmless_command_still_clears(command):
    assert clears_floor(command) is True
