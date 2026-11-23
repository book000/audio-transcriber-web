import http.client
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


class SnapshotUploadsTest(unittest.TestCase):
    backend = "python"

    @classmethod
    def setUpClass(cls):
        if cls.backend == "php":
            if os.environ.get("TRANSCRIBER_TEST_URL"):
                raise unittest.SkipTest("Using the externally managed backend instead")
            if not shutil.which("php"):
                raise unittest.SkipTest("PHP executable is not available")
        cls.server = None
        cls.start_time = 1600000000 + secrets.randbelow(100000000)
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.directory = Path(cls.temporary.name)
        cls.url = os.environ.get("TRANSCRIBER_TEST_URL")
        cls.invalid_statuses = (400, 422)
        if cls.url:
            cls.directory = Path(os.environ["TRANSCRIBER_TEST_DIRECTORY"])
        else:
            root = Path(__file__).resolve().parents[1]
            cls.environment = os.environ.copy()
            cls.environment["TZ"] = "UTC"
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            if cls.backend == "php":
                public = cls.directory / "public"
                public.mkdir()
                shutil.copy(root / "api.php", public)
                cls.environment["TRANSCRIPT_DATA_DIR"] = str(cls.directory / "data")
                cls.environment.pop("PHP_CLI_SERVER_WORKERS", None)
                cls.url = f"http://127.0.0.1:{port}/api.php"
                cls.invalid_statuses = (400,)
                cls.command = [
                    "php",
                    "-d",
                    "date.timezone=UTC",
                    "-S",
                    f"127.0.0.1:{port}",
                    "-t",
                    str(public),
                ]
            else:
                shutil.copy(root / "main.py", cls.directory)
                shutil.copytree(root / "static", cls.directory / "static")
                cls.url = f"http://127.0.0.1:{port}/api"
                cls.invalid_statuses = (422,)
                cls.command = [
                    sys.executable,
                    "-m",
                    "uvicorn",
                    "main:app",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(port),
                ]
            cls.addClassCleanup(cls.stop_server)
            cls.start_server()

    @classmethod
    def start_server(cls):
        cls.server = subprocess.Popen(
            cls.command,
            cwd=cls.directory,
            env=cls.environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        for _ in range(100):
            try:
                with urlopen(Request(cls.url, method="HEAD"), timeout=1):
                    return
            except (URLError, TimeoutError):
                if cls.server.poll() is not None:
                    raise RuntimeError("Backend exited before startup")
                time.sleep(0.05)
        raise RuntimeError("Backend did not start")

    @classmethod
    def stop_server(cls):
        if cls.server is not None:
            cls.server.terminate()
            cls.server.wait(timeout=10)
            cls.server = None

    def setUp(self):
        self.start_time = type(self).start_time + list(
            unittest.defaultTestLoader.getTestCaseNames(type(self))
        ).index(self._testMethodName)
        filename = self.session_filename(self.start_time)
        self.base = self.directory / "data" / filename

    def session_filename(self, start_time):
        clock = (
            time.localtime if os.environ.get("TRANSCRIBER_TEST_URL") else time.gmtime
        )
        return time.strftime("%Y-%m-%d %H-%M-%S", clock(int(start_time)))

    def snapshot(self, revision):
        return {
            "startTime": self.start_time,
            "revision": revision,
            "timeStamp": revision,
            "transcript": f"part {revision}",
            "full": [
                {"timeStamp": i, "transcript": f"part {i}"}
                for i in range(1, revision + 1)
            ],
        }

    def post(self, snapshot):
        return self.post_raw(json.dumps(snapshot).encode())

    def post_raw(self, body):
        request = Request(
            self.url,
            data=body,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urlopen(request, timeout=10) as response:
                return response.status
        except HTTPError as error:
            with error:
                return error.code

    def assert_saved(self, snapshot):
        self.assertEqual(
            json.loads(Path(str(self.base) + ".json").read_text()), snapshot["full"]
        )
        self.assertEqual(
            Path(str(self.base) + ".log").read_text(),
            "\n".join(
                "{timeStamp}s\t{transcript}".format(**item) for item in snapshot["full"]
            ),
        )
        self.assertEqual(
            json.loads(Path(str(self.base) + ".snapshot.json").read_text()),
            {"revision": snapshot["revision"], "full": snapshot["full"]},
        )

    def test_reordered_and_duplicate_requests_keep_latest_snapshot(self):
        latest = self.snapshot(2)
        self.assertEqual(self.post(latest), 200)
        self.assertEqual(self.post(self.snapshot(1)), 200)
        duplicate = self.snapshot(2)
        duplicate["full"] = []
        self.assertEqual(self.post(duplicate), 200)
        self.assert_saved(latest)

    def test_health_check_has_no_body_or_storage_side_effects(self):
        before = set(self.directory.rglob("*"))
        with urlopen(Request(self.url, method="HEAD"), timeout=10) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), b"")
        self.assertEqual(set(self.directory.rglob("*")), before)

    def test_frontend_payload_preserves_unicode_and_uses_full_for_exports(self):
        snapshot = self.snapshot(1)
        snapshot["startTime"] += 0.75
        snapshot["timeStamp"] = 3
        snapshot["transcript"] = "latest result"
        snapshot["full"] = [
            {"timeStamp": 0, "transcript": "Hello\tworld\nこんにちは 🎤"},
            {"timeStamp": 3, "transcript": "latest result"},
        ]
        self.assertEqual(self.post(snapshot), 200)
        self.assert_saved(snapshot)

    def test_invalid_first_request_does_not_create_session_files(self):
        snapshot = self.snapshot(1)
        snapshot["full"] = [{"timeStamp": -1, "transcript": "invalid"}]
        self.assertIn(self.post(snapshot), self.invalid_statuses)
        self.assertEqual(list(self.base.parent.glob(self.base.name + ".*")), [])

    def test_concurrent_requests_keep_highest_revision(self):
        revisions = [8, 1, 7, 2, 6, 3, 5, 4]
        with ThreadPoolExecutor(max_workers=8) as pool:
            statuses = list(pool.map(lambda n: self.post(self.snapshot(n)), revisions))
        self.assertEqual(statuses, [200] * len(revisions))
        self.assert_saved(self.snapshot(8))

    def test_revision_is_retained_across_server_restart(self):
        if not self.server:
            self.skipTest("Externally managed backend; restart tested separately")
        self.assertEqual(self.post(self.snapshot(2)), 200)
        type(self).stop_server()
        type(self).start_server()
        self.assertEqual(self.post(self.snapshot(1)), 200)
        self.assert_saved(self.snapshot(2))

    def test_failed_export_is_repaired_without_accepting_older_data(self):
        self.base.parent.mkdir(exist_ok=True)
        blocked = Path(str(self.base) + ".log")
        blocked.mkdir()
        try:
            self.assertEqual(self.post(self.snapshot(2)), 500)
        finally:
            blocked.rmdir()
        self.assertEqual(self.post(self.snapshot(1)), 200)
        self.assert_saved(self.snapshot(2))

    def test_invalid_revisions_leave_saved_snapshot_unchanged(self):
        self.assertEqual(self.post(self.snapshot(2)), 200)
        for revision in (None, 0, -1, True, 1.5, "3", 9007199254740992):
            with self.subTest(revision=revision):
                invalid = self.snapshot(1)
                invalid["revision"] = revision
                self.assertIn(self.post(invalid), self.invalid_statuses)
        missing = self.snapshot(1)
        del missing["revision"]
        self.assertIn(self.post(missing), self.invalid_statuses)
        self.assert_saved(self.snapshot(2))

    def test_invalid_transcript_entries_leave_saved_snapshot_unchanged(self):
        self.assertEqual(self.post(self.snapshot(2)), 200)
        for entry in (None, {}, "text", {"timeStamp": 1, "transcript": None}):
            invalid = self.snapshot(3)
            invalid["full"] = [entry]
            self.assertIn(self.post(invalid), self.invalid_statuses)
        self.assert_saved(self.snapshot(2))

    def test_invalid_json_shapes_leave_saved_snapshot_unchanged(self):
        self.assertEqual(self.post(self.snapshot(2)), 200)
        for body in (
            b"",
            b"{",
            b"null",
            b"[]",
            b"1",
            b'"text"',
            b"true",
            b'"\\ud800"',
            b'{"transcript":"\\ud800"}',
        ):
            with self.subTest(body=body):
                self.assertIn(self.post_raw(body), self.invalid_statuses)
        for value in (None, {}, {"0": self.snapshot(1)["full"][0]}, "text", 1):
            with self.subTest(full=value):
                invalid = self.snapshot(3)
                invalid["full"] = value
                self.assertIn(self.post(invalid), self.invalid_statuses)
        self.assert_saved(self.snapshot(2))

    def test_required_fields_and_types_are_validated(self):
        self.assertEqual(self.post(self.snapshot(2)), 200)
        for field in ("startTime", "revision", "transcript", "full"):
            with self.subTest(missing=field):
                invalid = self.snapshot(3)
                del invalid[field]
                self.assertIn(self.post(invalid), self.invalid_statuses)
        for value in (None, True, 1, [], {}, "\ud800"):
            for nested in (False, True):
                with self.subTest(transcript=value, nested=nested):
                    invalid = self.snapshot(3)
                    if nested:
                        invalid["full"][0]["transcript"] = value
                    else:
                        invalid["transcript"] = value
                    self.assertIn(self.post(invalid), self.invalid_statuses)
        for entry in (1, [], [1, "text"], {"transcript": "text"}, {"timeStamp": 1}):
            with self.subTest(entry=entry):
                invalid = self.snapshot(3)
                invalid["full"] = [entry]
                self.assertIn(self.post(invalid), self.invalid_statuses)
        self.assert_saved(self.snapshot(2))

    def test_invalid_timestamps_leave_saved_snapshot_unchanged(self):
        self.assertEqual(self.post(self.snapshot(2)), 200)
        invalid_values = (
            None,
            True,
            "1600000000",
            [],
            {},
            -1,
            -0.5,
            4102444800,
            10**30,
            float("nan"),
            float("inf"),
            -float("inf"),
        )
        for value in invalid_values:
            for nested in (False, True):
                with self.subTest(value=value, nested=nested):
                    invalid = self.snapshot(3)
                    if nested:
                        invalid["full"][0]["timeStamp"] = value
                    else:
                        invalid["startTime"] = value
                    self.assertIn(self.post(invalid), self.invalid_statuses)
        for value in (1.0, 1.5):
            invalid = self.snapshot(3)
            invalid["full"][0]["timeStamp"] = value
            self.assertIn(self.post(invalid), self.invalid_statuses)
        self.assert_saved(self.snapshot(2))

    def test_payload_size_limits_leave_saved_snapshot_unchanged(self):
        self.assertEqual(self.post(self.snapshot(2)), 200)
        for text in ("a" * 65537, "あ" * 21846):
            for nested in (False, True):
                with self.subTest(nested=nested, bytes=len(text.encode())):
                    invalid = self.snapshot(3)
                    if nested:
                        invalid["full"][0]["transcript"] = text
                    else:
                        invalid["transcript"] = text
                    self.assertIn(self.post(invalid), self.invalid_statuses)
        for full in (
            [{"timeStamp": 0, "transcript": ""}] * 10001,
            [{"timeStamp": 0, "transcript": "a" * 65536}] * 17,
        ):
            invalid = self.snapshot(3)
            invalid["full"] = full
            self.assertIn(self.post(invalid), self.invalid_statuses)
        self.assert_saved(self.snapshot(2))

    def test_valid_boundary_payloads_are_saved(self):
        snapshot = self.snapshot(1)
        snapshot["transcript"] = "あ" * 21845 + "a"
        snapshot["full"] = [{"timeStamp": 4102444799, "transcript": "a" * 65536}] * 16
        self.assertEqual(self.post(snapshot), 200)
        self.assert_saved(snapshot)
        snapshot["revision"] = 2
        snapshot["full"] = [{"timeStamp": 0, "transcript": ""}] * 10000
        self.assertEqual(self.post(snapshot), 200)
        self.assert_saved(snapshot)

    def test_start_time_boundaries_are_saved(self):
        for value in (0, 4102444799.75):
            with self.subTest(start_time=value):
                snapshot = self.snapshot(1)
                snapshot["startTime"] = value
                self.assertEqual(self.post(snapshot), 200)
                self.start_time = int(value)
                filename = self.session_filename(value)
                self.base = self.directory / "data" / filename
                self.assert_saved(snapshot)

    def test_storage_failure_returns_error_without_successful_snapshot(self):
        self.base.parent.mkdir(exist_ok=True)
        blocked = Path(str(self.base) + ".lock")
        blocked.mkdir()
        try:
            self.assertEqual(self.post(self.snapshot(1)), 500)
            self.assertFalse(Path(str(self.base) + ".snapshot.json").exists())
            self.assertFalse(Path(str(self.base) + ".json").exists())
        finally:
            blocked.rmdir()
        self.assertEqual(self.post(self.snapshot(1)), 200)
        self.assert_saved(self.snapshot(1))

    def test_unwritable_storage_preserves_saved_snapshot(self):
        self.assertEqual(self.post(self.snapshot(2)), 200)
        permissions = self.base.parent.stat().st_mode & 0o777
        try:
            self.base.parent.chmod(0o555)
            if os.access(self.base.parent, os.W_OK):
                self.skipTest("Current user can bypass directory permissions")
            self.assertEqual(self.post(self.snapshot(3)), 500)
        finally:
            self.base.parent.chmod(permissions)
        self.assert_saved(self.snapshot(2))

    def test_unknown_fields_are_ignored_and_top_level_timestamp_is_optional(self):
        snapshot = self.snapshot(1)
        del snapshot["timeStamp"]
        snapshot["extra"] = {"ignored": True}
        snapshot["full"][0]["extra"] = {"ignored": True}
        self.assertEqual(self.post(snapshot), 200)
        del snapshot["full"][0]["extra"]
        self.assert_saved(snapshot)
        snapshot["revision"] = 9007199254740991
        snapshot["full"] = []
        self.assertEqual(self.post(snapshot), 200)
        self.assert_saved(snapshot)

    def test_fractional_start_time_is_truncated(self):
        snapshot = self.snapshot(2)
        snapshot["startTime"] = self.start_time + 0.75
        self.assertEqual(self.post(snapshot), 200)
        self.assert_saved(snapshot)

    def get(self, path):
        parsed = urlsplit(self.url)
        connection = http.client.HTTPConnection(
            parsed.hostname, parsed.port, timeout=10
        )
        try:
            connection.request("GET", path)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def test_static_files_are_served_and_sibling_traversal_is_rejected(self):
        if self.backend != "python" or os.environ.get("TRANSCRIBER_TEST_URL"):
            self.skipTest("Depends on the spawned backend's directory layout")
        secret = b"sibling secret"
        (self.directory / "static_private.txt").write_bytes(secret)
        status, body = self.get("/style.css")
        self.assertEqual(status, 200)
        self.assertEqual(body, (self.directory / "static" / "style.css").read_bytes())
        status, body = self.get("/../static_private.txt")
        self.assertNotEqual(status, 200)
        self.assertNotEqual(body, secret)

    def test_recording_sessions_have_independent_revisions(self):
        self.assertEqual(self.post(self.snapshot(2)), 200)
        other = self.snapshot(1)
        other["startTime"] += 1000
        self.assertEqual(self.post(other), 200)
        self.assert_saved(self.snapshot(2))
        self.start_time = other["startTime"]
        filename = self.session_filename(self.start_time)
        self.base = self.directory / "data" / filename
        self.assert_saved(other)


class PhpSnapshotUploadsTest(SnapshotUploadsTest):
    backend = "php"


if __name__ == "__main__":
    unittest.main()
