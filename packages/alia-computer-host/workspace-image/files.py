"""The workspace file API: one JSON request on stdin, one JSON answer on stdout.

Adapted from OpenMuse `apps/computer/files.py` (MIT, see ../NOTICE).

It runs INSIDE the actor's container, as uid 1000, under `python3 -I` and a
`timeout`, so the worst a hostile path can reach is what that user can already
reach with a shell. What it adds on top is that no component of a path is ever
followed through a symlink: every directory is opened with O_NOFOLLOW relative
to the one before it, starting from /workspace, so a link the agent planted
cannot turn a read of /workspace/notes into a read of somewhere else.

Writes are atomic (temporary file, fsync, rename) and refuse to replace anything
that is not a regular file. Text only, 256 KB each way.

`write_bytes` is the one binary write: a file the agent's browser downloaded
(PDF, image, office document, text), base64 on stdin, at most 20 MiB. It never
replaces anything — an existing name gets " (1)", " (2)"… — and creates its
parent directories, so `/workspace/downloads` appears on the first download.
"""
import base64
import json
import os
import stat
import sys
import uuid

LIMIT = 256 * 1024
BYTES_LIMIT = 20 * 1024 * 1024
STDIN_LIMIT = 30 * 1024 * 1024
MAX_ENTRIES = 1000
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
# Where "/workspace" lives on disk. Always /workspace in the container; the
# host never passes --root, which exists so the suite can run this file against
# a temporary directory (src/__tests__/files-py.test.ts).
ROOT = sys.argv[2] if len(sys.argv) == 3 and sys.argv[1] == "--root" else "/workspace"


def main():
    request = json.loads(sys.stdin.buffer.read(STDIN_LIMIT))
    path = request["path"]
    if not isinstance(path, str) or "\x00" in path or ".." in path.split("/"):
        raise ValueError("Invalid workspace path")
    parts = path.split("/")
    if parts[:2] != ["", "workspace"]:
        raise ValueError("Path must be inside /workspace")
    parts = [part for part in parts[2:] if part and part != "."]
    operation = request["operation"]
    if operation not in ("list", "read", "write", "mkdir", "write_bytes"):
        raise ValueError("Unsupported file operation")
    directory = os.open(ROOT, DIRECTORY_FLAGS)
    try:
        parents = parts if operation in ("list", "mkdir") else parts[:-1]
        for part in parents:
            if operation in ("mkdir", "write_bytes"):
                try:
                    os.mkdir(part, mode=0o700, dir_fd=directory)
                except FileExistsError:
                    pass
            child = os.open(part, DIRECTORY_FLAGS, dir_fd=directory)
            os.close(directory)
            directory = child
        result = {"path": "/workspace" + ("/" + "/".join(parts) if parts else "")}
        if operation == "list":
            entries = []
            truncated = False
            with os.scandir(directory) as iterator:
                for entry in iterator:
                    if len(entries) >= MAX_ENTRIES:
                        truncated = True
                        break
                    info = entry.stat(follow_symlinks=False)
                    kind = (
                        "symlink" if stat.S_ISLNK(info.st_mode)
                        else "directory" if stat.S_ISDIR(info.st_mode)
                        else "file" if stat.S_ISREG(info.st_mode)
                        else "other"
                    )
                    entries.append({
                        "name": entry.name,
                        "path": result["path"] + "/" + entry.name,
                        "type": kind,
                        "size": info.st_size,
                    })
            result["entries"] = sorted(entries, key=lambda e: (e["type"] != "directory", e["name"]))
            result["truncated"] = truncated
        elif operation == "read":
            if not parts:
                raise ValueError("Choose a file")
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            with os.fdopen(fd, "rb") as source:
                if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                    raise ValueError("Only regular files can be read")
                content = source.read(LIMIT + 1)
                if len(content) > LIMIT:
                    raise ValueError("File exceeds size limit")
            result["text"] = content.decode("utf-8", errors="strict")
        elif operation == "write":
            if not parts:
                raise ValueError("Choose a file")
            text = request["text"]
            if not isinstance(text, str):
                raise ValueError("Text must be a string")
            content = text.encode("utf-8")
            if len(content) > LIMIT:
                raise ValueError("File exceeds size limit")
            # Refuse symlinks and special files even when atomically replacing.
            try:
                info = os.stat(parts[-1], dir_fd=directory, follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError("Only regular files can be replaced")
            except FileNotFoundError:
                pass
            temporary = ".alia-" + uuid.uuid4().hex
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            try:
                with os.fdopen(fd, "wb") as target:
                    target.write(content)
                    target.flush()
                    os.fsync(target.fileno())
                os.replace(temporary, parts[-1], src_dir_fd=directory, dst_dir_fd=directory)
            finally:
                try:
                    os.unlink(temporary, dir_fd=directory)
                except FileNotFoundError:
                    pass
            result["bytes"] = len(content)
        elif operation == "write_bytes":
            if not parts:
                raise ValueError("Choose a file")
            data = request["data"]
            if not isinstance(data, str) or len(data) > (BYTES_LIMIT * 4) // 3 + 8:
                raise ValueError("File exceeds size limit")
            content = base64.b64decode(data, validate=True)
            if len(content) > BYTES_LIMIT:
                raise ValueError("File exceeds size limit")
            stem, dot, extension = parts[-1].rpartition(".")
            if not dot or not stem:
                stem, extension = parts[-1], ""
            name = parts[-1]
            for attempt in range(1, 101):
                try:
                    # O_EXCL: never replaces, never follows a planted link.
                    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
                    break
                except FileExistsError:
                    name = stem + " (" + str(attempt) + ")" + ("." + extension if extension else "")
            else:
                raise ValueError("Too many files with that name")
            try:
                with os.fdopen(fd, "wb") as target:
                    target.write(content)
                    target.flush()
                    os.fsync(target.fileno())
            except BaseException:
                os.unlink(name, dir_fd=directory)
                raise
            prefix = "/workspace" + ("/" + "/".join(parts[:-1]) if parts[:-1] else "")
            result["path"] = prefix + "/" + name
            result["bytes"] = len(content)
        print(json.dumps(result))
    finally:
        os.close(directory)


try:
    main()
except (OSError, ValueError, KeyError, TypeError, UnicodeDecodeError) as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
