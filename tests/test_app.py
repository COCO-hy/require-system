# -*- coding: utf-8 -*-
"""REQ-2025-002 单元测试：app.py 纯函数 + 初始化 + 静态路由安全"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import app  # noqa: E402


class TestNormalizeGiteeRepo(unittest.TestCase):
    """UC-01 仓库地址规范化"""

    def test_empty_values(self):
        for v in ("", None, "   "):
            self.assertEqual(app.normalize_gitee_repo(v), "")

    def test_https_url(self):
        self.assertEqual(app.normalize_gitee_repo("https://gitee.com/owner/repo"), "owner/repo")

    def test_https_url_with_git(self):
        self.assertEqual(app.normalize_gitee_repo("https://gitee.com/owner/repo.git"), "owner/repo")

    def test_http_url(self):
        self.assertEqual(app.normalize_gitee_repo("http://gitee.com/owner/repo"), "owner/repo")

    def test_ssh(self):
        self.assertEqual(app.normalize_gitee_repo("git@gitee.com:owner/repo.git"), "owner/repo")

    def test_short_form(self):
        self.assertEqual(app.normalize_gitee_repo("owner/repo"), "owner/repo")
        self.assertEqual(app.normalize_gitee_repo("owner/repo.git"), "owner/repo")

    def test_slashes(self):
        self.assertEqual(app.normalize_gitee_repo("/owner/repo/"), "owner/repo")


class TestSafeParse(unittest.TestCase):
    """UC-02 容错解析"""

    def test_valid(self):
        self.assertEqual(app.safe_parse('{"a":1}', {}), {"a": 1})

    def test_invalid_returns_fallback(self):
        self.assertEqual(app.safe_parse("not-json", {"x": 0}), {"x": 0})

    def test_empty_returns_fallback(self):
        self.assertEqual(app.safe_parse("", []), [])
        self.assertIsNone(app.safe_parse(None, None))


class TestInitDb(unittest.TestCase):
    """UC-03 幂等建库 + seed"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        app.DB_PATH = Path(self.tmp.name) / "requirements.db"
        app.UPLOAD_DIR = Path(self.tmp.name) / "uploads"

    def tearDown(self):
        self.tmp.cleanup()

    def test_create_and_seed(self):
        app.init_db()
        import sqlite3
        conn = sqlite3.connect(app.DB_PATH)
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertIn("systems", tables)
        self.assertIn("requirements", tables)
        n = conn.execute("SELECT COUNT(*) FROM systems").fetchone()[0]
        self.assertEqual(n, 4)
        conn.close()

    def test_idempotent(self):
        app.init_db()
        app.init_db()
        import sqlite3
        conn = sqlite3.connect(app.DB_PATH)
        n = conn.execute("SELECT COUNT(*) FROM systems").fetchone()[0]
        self.assertEqual(n, 4)
        conn.close()


class TestResolvePublicPath(unittest.TestCase):
    """UC-04 静态路由：命中 / 穿越 / SPA 回退"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        pub = Path(self.tmp.name)
        (pub / "index.html").write_text("<html>idx</html>", encoding="utf-8")
        (pub / "css").mkdir()
        (pub / "css" / "style.css").write_text("body{}", encoding="utf-8")
        secret = Path(self.tmp.name).parent / "secret.txt"
        secret.write_text("SECRET", encoding="utf-8")
        self.secret = secret
        app.PUBLIC_DIR = pub

    def tearDown(self):
        self.secret.unlink(missing_ok=True)
        self.tmp.cleanup()

    def test_hit_file(self):
        p = app.resolve_public_path("/css/style.css")
        self.assertIsNotNone(p)
        self.assertEqual(p.name, "style.css")

    def test_traversal_rejected(self):
        self.assertIsNone(app.resolve_public_path("/../secret.txt"))
        self.assertIsNone(app.resolve_public_path("/%2e%2e/secret.txt"))

    def test_spa_fallback(self):
        p = app.resolve_public_path("/detail/3")
        self.assertIsNotNone(p)
        self.assertEqual(p.name, "index.html")


if __name__ == "__main__":
    unittest.main()
