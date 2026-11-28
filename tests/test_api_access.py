import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


class APIAccessCases:
    origin = "https://book000.github.io"
    token = "test-only-api-token"

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.public = self.directory / "public"
        self.public.mkdir()
        root = Path(__file__).resolve().parents[1]
        shutil.copy(root / "api.php", self.public)
        shutil.copy(root / "main.py", self.directory)
        shutil.copytree(root / "static", self.directory / "static")
        self.server = None
        self.addCleanup(self.stop_server)

    def start_server(self, origins=None, token=None):
        self.stop_server()
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        self.base_url = f"http://127.0.0.1:{port}"
        env = os.environ.copy()
        env["TRANSCRIPT_ALLOWED_ORIGINS"] = self.origin if origins is None else origins
        env["TRANSCRIPT_API_TOKEN"] = self.token if token is None else token
        env["TRANSCRIPT_DATA_DIR"] = str(self.directory / "data")
        if self.backend == "php":
            command = ["php", "-S", f"127.0.0.1:{port}", "-t", str(self.public)]
            self.url = self.base_url + "/api.php"
        else:
            command = [
                sys.executable,
                "-m",
                "uvicorn",
                "main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
            ]
            self.url = self.base_url + "/api"
            if getattr(self, "root_path", ""):
                command.extend(["--root-path", self.root_path])
        self.server = subprocess.Popen(
            command,
            cwd=self.directory,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        for _ in range(200):
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                    return
            except OSError:
                if self.server.poll() is not None:
                    self.fail("Backend exited before startup")
                time.sleep(0.05)
        self.fail("Backend did not start")

    def stop_server(self):
        if self.server is not None:
            self.server.terminate()
            self.server.wait(timeout=10)
            self.server = None

    def request(self, method="POST", headers=None, body=None):
        if body is None and method == "POST":
            body = json.dumps(
                {
                    "startTime": 1600000000,
                    "revision": 1,
                    "transcript": "saved",
                    "full": [{"timeStamp": 1, "transcript": "saved"}],
                }
            ).encode()
        request = Request(
            self.url,
            method=method,
            headers={"Content-Type": "application/json", **(headers or {})},
            data=body,
        )
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read()

    def auth_headers(self, origin=None):
        return {
            "Origin": self.origin if origin is None else origin,
            "Authorization": "Bearer " + self.token,
        }

    def preflight(self, method="POST", headers="content-type, authorization"):
        return self.request(
            "OPTIONS",
            {
                "Origin": self.origin,
                "Access-Control-Request-Method": method,
                "Access-Control-Request-Headers": headers,
            },
        )

    def assert_cors(self, headers):
        self.assertEqual(headers["Access-Control-Allow-Origin"], self.origin)
        self.assertIn("origin", headers["Vary"].lower())
        self.assertIsNone(headers["Access-Control-Allow-Credentials"])

    def assert_no_files(self):
        self.assertFalse((self.directory / "data").exists())

    def test_preflight_does_not_require_authentication_or_write_files(self):
        self.start_server()
        for method in ("POST", "HEAD", "OPTIONS"):
            with self.subTest(method=method):
                status, headers, _ = self.preflight(method)
                self.assertEqual(status, 200)
                self.assert_cors(headers)
                self.assertIn(method, headers["Access-Control-Allow-Methods"])
                self.assertIn(
                    "authorization", headers["Access-Control-Allow-Headers"].lower()
                )
                self.assertIn(
                    "content-type", headers["Access-Control-Allow-Headers"].lower()
                )
        self.assert_no_files()

    def test_disallowed_preflight_method_or_header(self):
        self.start_server()
        for method, header in (("DELETE", "content-type"), ("POST", "x-untrusted")):
            with self.subTest(method=method, header=header):
                self.assertEqual(self.preflight(method, header)[0], 400)
        status, headers, _ = self.request(
            "OPTIONS",
            {
                "Origin": self.origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Private-Network": "true",
            },
        )
        self.assertEqual(status, 400)
        self.assertIsNone(headers["Access-Control-Allow-Private-Network"])
        self.assert_no_files()

    def test_authenticated_cross_origin_post_and_head(self):
        self.start_server(origins=" https://other.example, " + self.origin + " ")
        status, headers, body = self.request("HEAD", self.auth_headers())
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")
        self.assert_cors(headers)
        status, headers, _ = self.request(headers=self.auth_headers())
        self.assertEqual(status, 200)
        self.assert_cors(headers)
        exports = list((self.directory / "data").glob("*.json"))
        self.assertEqual(len(exports), 2)
        exported = next(
            path for path in exports if not path.name.endswith(".snapshot.json")
        )
        self.assertEqual(
            json.loads(exported.read_text()), [{"timeStamp": 1, "transcript": "saved"}]
        )

    def test_missing_or_invalid_token_cannot_write_with_or_without_origin(self):
        self.start_server()
        for origin in (None, self.origin, self.base_url):
            for token in (None, "Bearer wrong-token", "Basic wrong-token"):
                for method in ("POST", "HEAD"):
                    with self.subTest(origin=origin, token=token, method=method):
                        supplied = {}
                        if origin is not None:
                            supplied["Origin"] = origin
                        if token is not None:
                            supplied["Authorization"] = token
                        status, headers, _ = self.request(method, supplied)
                        self.assertEqual(status, 401)
                        self.assertEqual(headers["WWW-Authenticate"], "Bearer")
                        if origin == self.origin:
                            self.assert_cors(headers)
        self.assert_no_files()

    def test_unlisted_origins_cannot_write_even_with_valid_token(self):
        self.start_server()
        for origin in (
            "https://untrusted.example",
            "null",
            "https://book000.github.io.evil.example",
            "http://book000.github.io",
            self.origin + ":444",
        ):
            with self.subTest(origin=origin):
                status, headers, _ = self.request(headers=self.auth_headers(origin))
                self.assertEqual(status, 403)
                self.assertIsNone(headers["Access-Control-Allow-Origin"])
                status, headers, _ = self.request(
                    "OPTIONS",
                    {
                        "Origin": origin,
                        "Access-Control-Request-Method": "POST",
                    },
                )
                self.assertEqual(status, 400)
                self.assertIsNone(headers["Access-Control-Allow-Origin"])
        self.assert_no_files()

    def test_invalid_configuration_fails_closed(self):
        for origins, token in (
            (self.origin, ""),
            ("*", self.token),
            ("null", self.token),
            (self.origin + "/", self.token),
        ):
            with self.subTest(origins=origins, missing_token=not token):
                self.start_server(origins, token)
                for method in ("POST", "HEAD", "OPTIONS"):
                    status, headers, _ = self.request(method, self.auth_headers())
                    self.assertEqual(status, 503)
                    self.assertIsNone(headers["Access-Control-Allow-Origin"])
        self.assert_no_files()

    def test_default_lan_use_and_same_origin_are_preserved(self):
        self.start_server(origins="", token="")
        for origin in (None, self.base_url):
            for method in ("POST", "HEAD"):
                status, headers, _ = self.request(
                    method, {"Origin": origin} if origin else {}
                )
                self.assertEqual(status, 200)
                self.assertIsNone(headers["Access-Control-Allow-Origin"])
        self.assertEqual(self.request(headers={"Origin": self.origin})[0], 403)

    def test_token_without_allowlist_protects_direct_clients(self):
        self.start_server(origins="")
        self.assertEqual(self.request()[0], 401)
        self.assertEqual(self.request(headers=self.auth_headers(self.base_url))[0], 200)
        self.assertEqual(self.request(headers=self.auth_headers())[0], 403)

    def test_errors_retain_cors_headers(self):
        self.start_server()
        status, headers, _ = self.request(headers=self.auth_headers(), body=b"{}")
        self.assertIn(status, (400, 422))
        self.assert_cors(headers)
        (self.directory / "data").write_text("Not a directory")
        status, headers, _ = self.request(headers=self.auth_headers())
        self.assertEqual(status, 500)
        self.assert_cors(headers)

    def test_unsupported_methods_and_plain_options_do_not_write(self):
        self.start_server()
        self.assertEqual(self.request("DELETE", self.auth_headers())[0], 405)
        self.assertEqual(self.request("OPTIONS")[0], 204)
        self.assert_no_files()


class PythonAPIAccessTest(APIAccessCases, unittest.TestCase):
    backend = "python"

    def test_root_path_preserves_authentication_and_same_origin(self):
        self.root_path = "/transcriber"
        self.start_server()
        self.assertEqual(self.request()[0], 401)
        self.assertEqual(self.request(headers=self.auth_headers(self.base_url))[0], 200)
        self.assertEqual(self.request(headers=self.auth_headers())[0], 200)
        self.start_server(origins="", token="")
        self.assertEqual(self.request("HEAD", {"Origin": self.base_url})[0], 200)


@unittest.skipUnless(shutil.which("php"), "PHP executable is not installed")
class PHPAPIAccessTest(APIAccessCases, unittest.TestCase):
    backend = "php"


if __name__ == "__main__":
    unittest.main()
