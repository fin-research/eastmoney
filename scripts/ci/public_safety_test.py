import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


class PublicSafetyTests(unittest.TestCase):
    def test_scans_staged_bytes_and_rejects_local_credential_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = root / "scripts/ci/public-safety.py"
            script.parent.mkdir(parents=True)
            shutil.copyfile(Path(__file__).with_name("public-safety.py"), script)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(["git", "add", "."], cwd=root, check=True)
            for name in [".env", ".dev.vars"]:
                file = root / name
                file.write_text("LOCAL_ONLY=fixture\n")
                subprocess.run(["git", "add", name], cwd=root, check=True)
                result = subprocess.run(["python3", str(script)], capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                subprocess.run(
                    ["git", "rm", "--cached", "-q", name], cwd=root, check=True
                )
                file.unlink()
            file = root / "example.txt"
            file.write_text("ghp_" + "A" * 40)
            subprocess.run(["git", "add", file.name], cwd=root, check=True)
            file.write_text("safe working tree\n")
            result = subprocess.run(["python3", str(script)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"GitHub token: example.txt", result.stderr)


if __name__ == "__main__":
    unittest.main()
