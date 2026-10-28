"""Local append-only content ledger. Local timestamps are not trusted time anchors."""

from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import tempfile

from model.prospective_protocol import checksum, encoded, require, sha


def now():
    return datetime.now(timezone.utc).isoformat()


def _sync(directory):
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _exclusive(path, content):
    """Link a fully synced temporary file into place; never overwrite existing bytes."""
    with tempfile.NamedTemporaryFile(
        dir=path.parent, prefix=".pending-", delete=False
    ) as file:
        temporary = Path(file.name)
        file.write(content)
        file.flush()
        os.fsync(file.fileno())
    try:
        try:
            os.link(temporary, path)
        except FileExistsError:
            require(
                path.is_file()
                and not path.is_symlink()
                and path.read_bytes() == content,
                "Immutable content conflict",
            )
        _sync(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


class Ledger:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        for name in ("objects", "events"):
            target = self.directory / name
            require(not target.is_symlink(), "Ledger directory symlink rejected")
            target.mkdir(exist_ok=True)

    @contextmanager
    def locked(self):
        fd = os.open(
            self.directory / ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600
        )
        with os.fdopen(fd, "a+b") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def object(self, digest):
        path = self.directory / "objects" / sha(digest)
        require(not path.is_symlink() and path.is_file(), "Missing ledger content")
        content = path.read_bytes()
        require(checksum(content) == digest, "Ledger content tampered")
        return content

    def put(self, content):
        require(isinstance(content, bytes), "Original bytes required")
        digest = checksum(content)
        _exclusive(self.directory / "objects" / digest, content)
        return digest

    def events(self):
        rows, previous, keys = [], None, set()
        files = sorted(
            p
            for p in (self.directory / "events").iterdir()
            if not p.name.startswith(".pending-")
        )
        for sequence, path in enumerate(files, 1):
            require(
                path.name == f"{sequence:08d}.json" and not path.is_symlink(),
                "Ledger chain gap",
            )
            content = path.read_bytes()
            event = json.loads(content)
            require(
                encoded(event) == content
                and set(event)
                == {
                    "sequence",
                    "key",
                    "kind",
                    "payload_sha256",
                    "attachments",
                    "previous_sha256",
                    "committed_at",
                    "time_anchor",
                },
                "Invalid ledger event",
            )
            require(
                event["sequence"] == sequence and event["previous_sha256"] == previous,
                "Ledger chain tampered",
            )
            require(
                event["key"] not in keys and event["time_anchor"] == "local_unanchored",
                "Invalid event identity",
            )
            self.object(event["payload_sha256"])
            for digest in event["attachments"]:
                self.object(digest)
            previous = checksum(content)
            keys.add(event["key"])
            rows.append(
                {
                    **event,
                    "event_sha256": previous,
                    "payload": json.loads(self.object(event["payload_sha256"])),
                }
            )
        return rows

    def append(self, kind, key, payload, attachments=(), validate=None):
        require(isinstance(key, str) and 0 < len(key) <= 512, "Invalid idempotency key")
        require(isinstance(kind, str) and kind, "Invalid event kind")
        payload_bytes = encoded(payload)
        with self.locked():
            events = self.events()
            hashes = sorted(set(self.put(content) for content in attachments))
            digest = self.put(payload_bytes)
            existing = next((row for row in events if row["key"] == key), None)
            if existing:
                require(
                    existing["kind"] == kind
                    and existing["payload_sha256"] == digest
                    and existing["attachments"] == hashes,
                    "Idempotency key conflict",
                )
                return existing
            if validate is not None:
                validate(events)
            event = {
                "sequence": len(events) + 1,
                "key": key,
                "kind": kind,
                "payload_sha256": digest,
                "attachments": hashes,
                "previous_sha256": events[-1]["event_sha256"] if events else None,
                "committed_at": now(),
                "time_anchor": "local_unanchored",
            }
            content = encoded(event)
            _exclusive(
                self.directory / "events" / f"{event['sequence']:08d}.json", content
            )
            return {**event, "event_sha256": checksum(content), "payload": payload}

    def audit(self):
        with self.locked():
            events = self.events()
            used = {
                digest
                for row in events
                for digest in [row["payload_sha256"], *row["attachments"]]
            }
            objects = list((self.directory / "objects").iterdir())
            for path in objects:
                if not path.name.startswith(".pending-"):
                    self.object(path.name)
            return {
                "events": len(events),
                "tip_sha256": events[-1]["event_sha256"] if events else None,
                "time_anchor": "local_unanchored",
                "forward_eligible": False,
                "orphan_objects": sorted(
                    p.name
                    for p in objects
                    if p.name not in used and not p.name.startswith(".pending-")
                ),
                "limitation": "local time and chain cannot prove prior publication or prevent suffix deletion",
            }
