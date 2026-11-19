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
from urllib.request import Request, urlopen


class SnapshotUploadsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = None
        cls.start_time = 1600000000 + secrets.randbelow(100000000)
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.directory = Path(cls.temporary.name)
        cls.url = os.environ.get("TRANSCRIBER_TEST_URL")
        if cls.url:
            cls.directory = Path(os.environ["TRANSCRIBER_TEST_DIRECTORY"])
        else:
            root = Path(__file__).resolve().parents[1]
            shutil.copy(root / "main.py", cls.directory)
            shutil.copytree(root / "static", cls.directory / "static")
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            cls.url = f"http://127.0.0.1:{port}/api"
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
        filename = time.strftime("%Y-%m-%d %H-%M-%S", time.localtime(self.start_time))
        self.base = self.directory / "data" / filename

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
        request = Request(
            self.url,
            data=json.dumps(snapshot).encode(),
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
                self.assertIn(self.post(invalid), (400, 422))
        missing = self.snapshot(1)
        del missing["revision"]
        self.assertIn(self.post(missing), (400, 422))
        self.assert_saved(self.snapshot(2))

    def test_invalid_transcript_entries_leave_saved_snapshot_unchanged(self):
        self.assertEqual(self.post(self.snapshot(2)), 200)
        for entry in (None, {}, "text", {"timeStamp": 1, "transcript": None}):
            invalid = self.snapshot(3)
            invalid["full"] = [entry]
            self.assertIn(self.post(invalid), (400, 422))
        self.assert_saved(self.snapshot(2))

    def test_recording_sessions_have_independent_revisions(self):
        self.assertEqual(self.post(self.snapshot(2)), 200)
        other = self.snapshot(1)
        other["startTime"] += 1000
        self.assertEqual(self.post(other), 200)
        self.assert_saved(self.snapshot(2))
        self.start_time = other["startTime"]
        filename = time.strftime("%Y-%m-%d %H-%M-%S", time.localtime(self.start_time))
        self.base = self.directory / "data" / filename
        self.assert_saved(other)


if __name__ == "__main__":
    unittest.main()
