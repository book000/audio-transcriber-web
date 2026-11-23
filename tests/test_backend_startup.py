import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class BackendStartupTest(unittest.TestCase):
    def test_import_does_not_start_server_open_browser_or_create_storage(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            shutil.copy(root / "main.py", directory)
            shutil.copytree(root / "static", directory / "static")
            result = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    (
                        "from unittest.mock import patch\n"
                        "import sys\n"
                        "sys.argv = ['main.py', '--open-browser']\n"
                        "with patch('uvicorn.run') as server, "
                        "patch('webbrowser.open') as browser, "
                        "patch('webbrowser.get') as controller:\n"
                        "    import main\n"
                        "    server.assert_not_called()\n"
                        "    browser.assert_not_called()\n"
                        "    controller.assert_not_called()\n"
                        "    assert main.app is not None\n"
                    ),
                ],
                cwd=directory,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertFalse((directory / "data").exists())


if __name__ == "__main__":
    unittest.main()
