"""A never-list: shell commands that are not approved automatically, whatever
a saved rule says.

Only a person, looking at the exact command on a card, can allow one of these.
The floor is one more condition in front of an automatic allow; it never
overrides a card someone answers, and it cannot reach what the CLI decides for
itself (for example edits under `accept_edits`).

The rules lean towards letting a command through: words used as data (an echo,
a commit message) are not commands, and only commands the reader is sure about
are blocked. The one exception is the security invariant: a command that could
not be read to the end (an unbalanced quote, command substitution, a nested
shell) is "unreadable", never "clear", and is also held for a person.

    delete-root, delete-home, delete-system-directory   rm -r on / ~ /etc ... (and find -delete / -exec rm there)
    permission-change-root                              chmod/chown -R on those
    format-disk, overwrite-disk                         mkfs, diskutil eraseDisk, dd of=/dev/sda, > /dev/sda
    force-push                                          git push --force / -f / +ref
    fork-bomb                                           :(){ :|:& };:  and  function f { f|f& }; f

A command whose program is itself a variable (`$CMD args`, `bash -c "$CMD"`)
cannot be known, so it is unreadable too.
"""

import posixpath
import re
import shlex
from dataclasses import dataclass

SYSTEM_DIRECTORIES = frozenset(
    {
        "/etc", "/usr", "/bin", "/sbin", "/var", "/boot", "/home", "/lib", "/lib32", "/lib64", "/libx32", "/lib*",
        "/opt", "/root", "/srv", "/dev", "/proc", "/sys", "/System", "/Library",
        "/Applications", "/Users", "/Volumes", "/private", "/private/etc", "/private/var",
    }
)
_HOME_WORDS = frozenset({"~", "$HOME", "${HOME}"})

# Wrappers that precede the real command.
_WRAPPERS = frozenset({"sudo", "doas", "env", "nohup", "command", "time", "exec", "nice", "ionice", "builtin", "stdbuf", "timeout"})
_REDIRECTS = frozenset({">", ">>", ">&", "&>", ">|"})
_SHELLS = frozenset({"sh", "bash", "zsh", "dash", "ksh", "fish"})
# Options of a wrapper that take a value as the next word. Kept per wrapper:
# treating a flag like `time -p` as taking a value would eat the command after
# it and hide the command from the checks below.
_VALUE_OPTIONS = {
    "env": frozenset({"-u", "--unset", "-C", "--chdir", "-S", "--split-string"}),
    "sudo": frozenset({"-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt",
                       "-C", "--chdir", "-T", "--command-timeout", "-D", "--chdir", "-r", "--role",
                       "-t", "--type", "-a", "--auth-type"}),
    "doas": frozenset({"-u", "-C"}),
    "timeout": frozenset({"-s", "--signal", "-k", "--kill-after"}),
    "nice": frozenset({"-n", "--adjustment"}),
    "ionice": frozenset({"-c", "-n", "-p"}),
    "stdbuf": frozenset({"-i", "-o", "-e"}),
    "exec": frozenset({"-a"}),
    "chrt": frozenset({"-p", "-m", "-P", "-r", "-o"}),
}
# Options that are always a value-eating option for the wrapper in front of them.
_MAX_NESTING = 3

# Programs that run another command named after their own options/operands. They
# are not wrappers (a wrapper precedes the command; these take arguments first)
# and not `xargs`/`find` (whose inner command is introduced by a flag). Each is
# read through to the inner command so `flock /tmp/l rm -rf ~` is seen as
# `rm -rf ~`; only a runner whose inner command cannot be recovered (an
# interpreter fed a `-c`/`-e` script) is held as unreadable.
# `_LEAD_OPTIONS[tool]` are options that take a value as the next word, so the
# command after them is not mistaken for the value.
_RUNNERS = frozenset(
    {"flock", "chroot", "busybox", "strace", "unshare", "nsenter", "su", "runuser", "setpriv", "toybox", "eatmydata"}
)
_LEAD_OPTIONS = {
    "flock": frozenset({"-w", "--wait", "--timeout", "-E", "--conflict-exit-code", "-c", "--command"}),
    "chroot": frozenset({"--userspec", "--groups", "--skip-chdir"}),
    "strace": frozenset(
        {"-e", "--trace", "-o", "--output", "-p", "--attach", "-s", "--string-limit", "-u", "--user",
         "-b", "--buffer-size", "-I", "--interruptible", "-a", "--columns"}
    ),
    "unshare": frozenset({"--setgroups", "--kill-child", "--mount-proc", "--root", "-w", "--wd"}),
    "nsenter": frozenset({"-t", "--target", "-w", "--wd", "-r", "--root", "-S", "--setuid", "-G", "--setgid"}),
    "su": frozenset({"-s", "--shell", "-g", "--group", "-G", "--supp-group", "--session-command"}),
    "runuser": frozenset({"-s", "--shell", "-g", "--group", "-G", "--supp-group", "-u", "--user"}),
    "setpriv": frozenset({"--reuid", "--regid", "--groups", "--inh-caps", "--ambient-caps", "--securebits", "--selinux-label"}),
}
# Interpreters run a script the checks cannot read: `python3 -c '...'`,
# `perl -e ...`, `node -e ...`. Used with a script file they are not runners and
# fall through to the ordinary rules (which read the file path, not its body).
_INTERPRETERS = frozenset({"python", "python2", "python3", "perl", "node", "nodejs", "ruby", "php", "lua", "rscript", "deno", "bun"})
# The interpreter option that runs a script given on the command line. `-r` is
# php's; `-c`/`-e` cover the rest. A runner's own `-r` (unshare, setpriv) is not
# in this set, so it is not mistaken for a script.
_INLINE_SCRIPT_FLAGS = frozenset({"-c", "-e", "--eval", "--command", "-r"})
_SCRIPT_FLAGS_WITHOUT_R = frozenset({"-c", "-e", "--eval", "--command"})

_DISK_DEVICE = re.compile(
    r"^/dev/(?:r?disk\d+(?:s\d+)*|disk/.+|sd[a-z]{1,3}\d*|hd[a-z]\d*|x?vd[a-z]{1,2}\d*|"
    r"nvme\d+(?:n\d+)?(?:p\d+)?|mmcblk\d+(?:p\d+)?|md\d+(?:p\d+)?|md/[^/]+|dm-\d+|mapper/(?!loop\d)[^/]+)$"
)
_SCRATCH_DEVICE = re.compile(r"^/dev/(?:mapper/)?(?:loop|ram|nbd|zram)\d")
# A function that pipes itself into itself in the background, then calls
# itself; written `f(){ ... }` or `function f { ... }`. The name is bounded.
_BOMB_BODY = r"\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;?\s*\1(?![\w:.-])"
_FORK_BOMBS = (
    re.compile(r"(?:^|[\s;&|(){}])([A-Za-z_:.][\w:.-]{0,63})\s*\(\s*\)" + _BOMB_BODY),
    re.compile(r"(?:^|[\s;&|(){}])function\s+([A-Za-z_:.][\w:.-]{0,63})\s*(?:\(\s*\))?" + _BOMB_BODY),
)
# diskutil verbs that erase a disk or volume.
_DISKUTIL_ERASE = frozenset({"erasedisk", "erasevolume", "reformat", "zerodisk", "randomdisk", "secureerase"})
# Substitution that hides what will run. Plain `$VAR` words are not read as
# anything (a word holding one is unknown, so it matches no rule).
_HIDDEN = re.compile(r"\$\(|`|<\(|>\(|\$'")

_LABELS = {
    "delete-root": "recursive delete of the filesystem root",
    "delete-home": "recursive delete of the home directory",
    "delete-system-directory": "recursive delete of a system directory",
    "permission-change-root": "recursive permission change of the root, home or a system directory",
    "format-disk": "formatting a disk",
    "overwrite-disk": "overwriting a disk device",
    "force-push": "a force push",
    "fork-bomb": "a fork bomb",
}


@dataclass(frozen=True)
class FloorVerdict:
    rule: str
    label: str  # words a person reads; never the command, which may hold a secret


@dataclass(frozen=True)
class FloorReading:
    readable: bool
    verdict: FloorVerdict | None = None

    @property
    def clear(self) -> bool:
        """True only for a command that was read and matched nothing."""
        return self.readable and self.verdict is None


def _verdict(rule: str) -> FloorVerdict:
    return FloorVerdict(rule, _LABELS[rule])


def _tokens(command: str) -> list[str] | None:
    """Words and operators, quotes removed. None when it cannot be read."""
    try:
        # A newline starts the next command, exactly like `;`. Left as plain
        # whitespace it would glue `echo hi` and `rm -rf ~` into one command
        # and hide the second from every rule below.
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|()\n")
        lexer.whitespace = " \t\r"
        lexer.whitespace_split = True
        lexer.commenters = ""
        return list(lexer)
    except ValueError:
        return None


def _split(tokens: list[str]) -> list[list[str]]:
    commands: list[list[str]] = [[]]
    for token in tokens:
        if token and all(ch in ";&|()\n" for ch in token):
            commands.append([])
        else:
            commands[-1].append(token)
    return [c for c in commands if c]


def _redirect_targets(words: list[str]) -> tuple[list[str], list[str]]:
    """The command's own words, and what its output redirections write to."""
    plain: list[str] = []
    targets: list[str] = []
    mode = ""  # "write" or "read": the next word is a redirection operand
    for word in words:
        if mode:
            if mode == "write":
                targets.append(word)
            mode = ""
        elif word in _REDIRECTS or re.fullmatch(r"\d*>>?", word):
            mode = "write"
        elif re.match(r"^\d*(?:>>?|&>)[^>&|]", word):
            targets.append(re.sub(r"^\d*(?:>>?|&>)", "", word))
        elif word in ("<", "<<", "<<<") or re.fullmatch(r"\d*<", word):
            mode = "read"
        else:
            plain.append(word)
    return plain, targets


def _strip_wrappers(words: list[str]) -> list[str]:
    """Drop `sudo`, `env X=1`, `nohup`, `timeout 5` ... in front of the command."""
    words = list(words)
    while words:
        head = words[0]
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", head):
            words.pop(0)
        elif posixpath.basename(head) in _WRAPPERS:
            wrapper = posixpath.basename(words.pop(0))
            value_options = _VALUE_OPTIONS.get(wrapper, frozenset())
            while words and words[0].startswith("-") and words[0] != "--":
                option = words.pop(0)
                # `--opt=value` carries its value; a bare option may take the
                # next word, but only for this wrapper's value options.
                if "=" not in option and option in value_options and words:
                    words.pop(0)
            if words and words[0] == "--":
                words.pop(0)
            if wrapper == "timeout" and words and re.fullmatch(r"\d+(?:\.\d+)?[smhd]?", words[0]):
                words.pop(0)
            if wrapper == "env":
                # `env NAME=value ...`: more environment assignments follow.
                while words and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", words[0]):
                    words.pop(0)
        else:
            break
    return words


_HOME_MARK = "/\ue000home"


def _dangerous_target(path: str) -> str | None:
    """The rule a recursive delete or permission change of `path` breaks."""
    if path.endswith(("/*", "/.*")):
        path = path[:-2] or "/"
    for home in ("~", "$HOME", "${HOME}"):
        if path == home or path.startswith(home + "/"):
            path = _HOME_MARK + path[len(home):]
            break
    if "$" in path or "`" in path or not path.startswith("/"):
        return None
    normal = posixpath.normpath("/" + path.lstrip("/"))
    if normal == _HOME_MARK:
        return "delete-home"
    if normal == "/":
        return "delete-root"
    if normal in SYSTEM_DIRECTORIES:
        return "delete-system-directory"
    return None


def _flags(words: list[str]) -> set[str]:
    flags: set[str] = set()
    for word in words:
        if word == "--":
            break
        if word.startswith("--"):
            flags.add(word.split("=", 1)[0])
        elif word.startswith("-") and len(word) > 1:
            flags.update(word[1:])
    return flags


def _find_start_paths(args: list[str]) -> list[str]:
    """The directories `find` walks: the words before its first test or action."""
    paths: list[str] = []
    for arg in args:
        if arg in ("-H", "-L", "-P") and not paths:
            continue
        if arg.startswith("-") or arg in ("(", "!"):
            break
        paths.append(arg)
    return paths


def _find_deletes(args: list[str]) -> bool:
    """True for `-delete`, or an `-exec`-style action that runs `rm`."""
    for index, arg in enumerate(args):
        if arg == "-delete":
            return True
        if arg in ("-exec", "-execdir", "-ok", "-okdir") and index + 1 < len(args):
            if posixpath.basename(args[index + 1]) in ("rm", "unlink"):
                return True
    return False


def _check_command(words: list[str], targets: list[str]) -> FloorVerdict | None:
    for target in targets:
        text = target.replace("//", "/")
        if text and _DISK_DEVICE.match(text) and not _SCRATCH_DEVICE.match(text):
            return _verdict("overwrite-disk")
    words = _strip_wrappers(words)
    if not words:
        return None
    name, args = posixpath.basename(words[0]), words[1:]
    operands = [a for a in args if not a.startswith("-") or a == "-"]
    flags = _flags(args)

    if name == "rm":
        if flags & {"r", "R", "--recursive"}:
            for operand in operands:
                rule = _dangerous_target(operand)
                if rule:
                    return _verdict(rule)
        if "--no-preserve-root" in args and any(
            o.startswith("/") and posixpath.normpath("/" + o.lstrip("/")) == "/" for o in operands
        ):
            return _verdict("delete-root")
    elif name == "find":
        if _find_deletes(args):
            for start in _find_start_paths(args):
                rule = _dangerous_target(start)
                if rule:
                    return _verdict(rule)
    elif name in ("chmod", "chown", "chgrp"):
        if flags & {"R", "--recursive"}:
            for operand in operands[1:]:  # the first operand is the mode or owner
                if _dangerous_target(operand):
                    return _verdict("permission-change-root")
    elif name.startswith("mkfs") or name in ("mke2fs", "newfs", "newfs_hfs", "newfs_apfs", "newfs_msdos", "wipefs", "blkdiscard"):
        if any(
            (n := o.replace("//", "/")).startswith("/dev/") and len(n) > 5 and not _SCRATCH_DEVICE.match(n)
            for o in operands
        ):
            return _verdict("format-disk")
    elif name == "diskutil":
        verbs = [o for o in operands if o.lower() != "apfs"]
        if verbs and verbs[0].lower() in _DISKUTIL_ERASE and "$" not in args[-1]:
            return _verdict("format-disk")
    elif name in ("dd", "shred"):
        for arg in args:
            device = arg[3:] if arg.startswith("of=") else arg if name == "shred" else ""
            device = device.replace("//", "/")
            if device and _DISK_DEVICE.match(device) and not _SCRATCH_DEVICE.match(device):
                return _verdict("overwrite-disk")
    elif name == "find":
        # `find <path> -delete` removes what the path names; `-exec rm -rf {} +`
        # is handled as a nested command by the caller.
        if "-delete" in args:
            for path in args:
                if path.startswith("-"):
                    break
                rule = _dangerous_target(path)
                if rule:
                    return _verdict(rule)
    elif name == "git":
        git_args = [a for a in args if a != "--no-pager"]
        # `git -C dir push ...`: skip global options that take a value.
        index = 0
        while index < len(git_args) and git_args[index].startswith("-"):
            index += 2 if git_args[index] in ("-C", "-c", "--git-dir", "--work-tree") else 1
        if git_args[index : index + 1] == ["push"]:
            rest = git_args[index + 1 :]
            if any(
                a in ("-f", "--force", "--force-with-lease", "--force-if-includes")
                or a.startswith("--force-with-lease=")
                or (a.startswith("-") and not a.startswith("--") and "f" in a[1:])
                or (a.startswith("+") and len(a) > 1)
                or re.match(r"^[^\s:]+:\+", a)
                for a in rest
            ):
                return _verdict("force-push")
    return None


def _indirect_commands(words: list[str]) -> list[list[str]]:
    """Commands a program runs for us, pulled out so the checks read them.

    `xargs rm -rf /` and `find / -exec rm -rf {} +` run another command;
    `env -S 'rm -rf /'` and `env --split-string=...` do too. A wrapper's words
    are returned, already split into whitespace-separated tokens."""
    if not words:
        return []
    head = posixpath.basename(words[0])
    rest = words[1:]
    if head == "xargs":
        index = 0
        while index < len(rest):
            word = rest[index]
            if word == "--":
                return [rest[index + 1 :]]
            if word.startswith("-") and "=" not in word and word in ("-a", "-E", "-I", "-n", "-s", "-P", "--max-args", "--max-chars", "--replace", "--delimiter", "--arg-file", "--process-slot-var"):
                index += 2
            elif word.startswith("-"):
                index += 1
            else:
                return [rest[index:]]
        return []
    if head == "find":
        paths = [w for w in rest if not w.startswith("-")]
        commands = []
        for index, word in enumerate(rest):
            if word in ("-exec", "-execdir") and index + 1 < len(rest):
                tail = rest[index + 1 :]
                for terminator in (";", "+"):
                    if terminator in tail:
                        tail = tail[: tail.index(terminator)]
                        break
                # `{}` stands for each match, so the searched paths are what
                # the command runs against.
                tail = [w for w in tail if w != "{}"] + paths[:1]
                if tail:
                    commands.append(tail)
        return commands
    if head == "env":
        for index, word in enumerate(rest):
            script = None
            if word in ("-S", "--split-string") and index + 1 < len(rest):
                script = rest[index + 1]
            elif word.startswith("--split-string="):
                script = word.split("=", 1)[1]
            if script:
                try:
                    return [shlex.split(script)]
                except ValueError:
                    return []
        return []
    return []


def _read_through(words: list[str]) -> list[str] | None:
    """The inner command of a runner, or None when there is none to read.

    `flock /tmp/l rm -rf ~` -> `rm -rf ~`; `busybox rm -rf /` -> `rm -rf /`;
    `chroot / rm -rf /` -> `rm -rf /`. Returns `[]` when the runner names no
    command (`flock /tmp/l`, `su - user`), and None when the inner command is a
    script the checks cannot read (`python3 -c ...`, `perl -e ...`)."""
    if not words:
        return []
    name = posixpath.basename(words[0])
    if name in _INTERPRETERS:
        rest = words[1:]
        if any(w in _INLINE_SCRIPT_FLAGS or any(w.startswith(f + "=") for f in ("--eval", "--command")) for w in rest):
            return None
        return []
    if name not in _RUNNERS:
        return []
    rest = words[1:]
    # Skip leading options (and the value of any that take one). A `-c`/`-e`/`-r`
    # among the runner's *own* options means it runs a script string, which the
    # checks cannot read.
    index = 0
    inline_script = False
    script_flags = _SCRIPT_FLAGS_WITHOUT_R
    value_options = _LEAD_OPTIONS.get(name, frozenset())
    while index < len(rest) and rest[index].startswith("-") and rest[index] != "--":
        option = rest[index]
        index += 1
        if option in script_flags or any(
            option.startswith(f + "=") for f in ("--eval", "--command")
        ):
            inline_script = True
        if "=" not in option and option in value_options and index < len(rest):
            index += 1
    if index < len(rest) and rest[index] == "--":
        index += 1
    if inline_script:
        return None
    if name in ("flock", "chroot"):
        index += 1  # the lock file / the new root
    if name == "busybox":
        # `busybox [applet] command...`: the applet is the command's program.
        if index >= len(rest):
            return []
        return rest[index:]
    if name in ("su", "runuser", "setpriv"):
        # `su [user [args...]]`: the first bare word is the user and what
        # follows is the command. `runuser -u user -- cmd` names the user as an
        # option, so no bare user operand is consumed.
        args = rest[index:]
        if not args:
            return []
        if args[0] == "-":
            args = args[1:]
        took_user_option = any(w in ("-u", "--user") for w in rest[:index])
        if name == "setpriv" or took_user_option:
            return args
        return args[1:] if len(args) > 1 else []
    if index >= len(rest):
        return []
    return rest[index:]


def floor_reading(command: str, _depth: int = 0) -> FloorReading:
    """Read one shell command line. A block found before something unreadable
    stands; otherwise anything unreadable is not clear."""
    if any(bomb.search(command) for bomb in _FORK_BOMBS):
        return FloorReading(True, _verdict("fork-bomb"))
    tokens = _tokens(command)
    if tokens is None:
        return FloorReading(False)
    readable = not _HIDDEN.search(command)
    for words in _split(tokens):
        plain, targets = _redirect_targets(words)
        found = _check_command(plain, targets)
        if found:
            return FloorReading(True, found)
        if _depth < _MAX_NESTING:
            for indirect in _indirect_commands(plain):
                nested = _check_command(indirect, [])
                if nested:
                    return FloorReading(True, nested)
                nested = floor_reading(" ".join(shlex.quote(w) for w in indirect), _depth + 1)
                if nested.verdict:
                    return nested
                readable = readable and nested.readable
        inner = _strip_wrappers(plain)
        if not inner:
            continue
        name, args = posixpath.basename(inner[0]), inner[1:]
        if "$" in inner[0]:
            readable = False  # the program is a variable: what runs is unknown
        elif name in _RUNNERS or name in _INTERPRETERS:
            # Read through to the command a runner actually runs. An interpreter
            # fed an inline script (`python3 -c ...`) is unreadable, so it is
            # held for a person rather than cleared.
            ran = _read_through(inner)
            if ran is None:
                readable = False
                continue
            if ran:
                found = _check_command(ran, [])
                if found:
                    return FloorReading(True, found)
                if _depth < _MAX_NESTING:
                    nested = floor_reading(
                        " ".join(shlex.quote(w) for w in ran), _depth + 1
                    )
                    if nested.verdict:
                        return nested
                    readable = readable and nested.readable
        elif name == "eval":
            # Its words are a script. One holding a variable is unknown.
            if not args or any("$" in a for a in args) or _depth >= _MAX_NESTING:
                readable = False
                continue
            nested = floor_reading(" ".join(args), _depth + 1)
            if nested.verdict:
                return nested
            readable = readable and nested.readable
        elif name in _SHELLS and "c" in _flags(args):
            script = next((a for a in args if not a.startswith("-")), None)
            if script is None or _depth >= _MAX_NESTING:
                readable = False
                continue
            nested = floor_reading(script, _depth + 1)
            if nested.verdict:
                return nested
            readable = readable and nested.readable
    return FloorReading(readable)


def clears_floor(command: str) -> bool:
    """False for a never-list command and for one that could not be read."""
    return floor_reading(command).clear
