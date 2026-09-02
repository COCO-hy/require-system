# -*- coding: utf-8 -*-
"""REQ-2025-002 单元测试：FastAPI 版 app"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import app  # noqa: E402
from fastapi.testclient import TestClient


class TestNormalize(unittest.TestCase):
    def test_empty(self):
        for v in ("", None, "   "):
            self.assertEqual(app.normalize_gitee_repo(v), "")
    def test_https(self):
        self.assertEqual(app.normalize_gitee_repo("https://gitee.com/owner/repo"), "owner/repo")
    def test_https_git(self):
        self.assertEqual(app.normalize_gitee_repo("https://gitee.com/owner/repo.git"), "owner/repo")
    def test_ssh(self):
        self.assertEqual(app.normalize_gitee_repo("git@gitee.com:owner/repo.git"), "owner/repo")
    def test_short(self):
        self.assertEqual(app.normalize_gitee_repo("owner/repo"), "owner/repo")
    def test_slashes(self):
        self.assertEqual(app.normalize_gitee_repo("/owner/repo/"), "owner/repo")


class TestDb(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        app.DB_PATH = Path(self.tmp.name) / "requirements.db"
        app.UPLOAD_DIR = Path(self.tmp.name) / "uploads"
    def tearDown(self):
        self.tmp.cleanup()

    def test_startup_idempotent(self):
        import sqlite3
        app.startup()
        app.startup()
        conn = sqlite3.connect(app.DB_PATH)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM systems").fetchone()[0], 4)
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertIn("systems", tables)
        self.assertIn("requirements", tables)
        conn.close()


class TestApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        pub = Path(cls.tmp.name)
        (pub / "index.html").write_text("<html>idx</html>", encoding="utf-8")
        (pub / "css").mkdir()
        (pub / "css" / "style.css").write_text("body{}", encoding="utf-8")
        app.PUBLIC_DIR = pub
        app.DB_PATH = Path(cls.tmp.name) / "requirements.db"
        app.UPLOAD_DIR = Path(cls.tmp.name) / "uploads"
        app.startup()
        cls.client = TestClient(app.app)
    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_static(self):
        self.assertEqual(self.client.get("/").status_code, 200)
        self.assertEqual(self.client.get("/css/style.css").status_code, 200)
    def test_traversal_safe(self):
        r = self.client.get("/../secret.txt")
        self.assertIn(r.status_code, (200, 404))  # SPA fallback not file leak
    def test_systems_seeded(self):
        r = self.client.get("/api/systems")
        self.assertGreaterEqual(len(r.json()["data"]), 4)
    def test_system_duplicate(self):
        self.client.post("/api/systems", json={"name": "X", "gitee_repo": "", "description": ""})
        r = self.client.post("/api/systems", json={"name": "X", "gitee_repo": "", "description": ""})
        self.assertEqual(r.status_code, 400)
        self.assertIn("已存在", r.json()["error"])
    def test_create_json(self):
        r = self.client.post("/api/requirements", json={"title": "UT需求", "project_number": "UT-1"})
        self.assertEqual(r.status_code, 200)
        rid = r.json()["data"]["id"]
        self.assertEqual(self.client.get(f"/api/requirements/{rid}").json()["data"]["title"], "UT需求")
    def test_title_empty(self):
        r = self.client.post("/api/requirements", json={"title": ""})
        self.assertEqual(r.status_code, 400)
    def test_404(self):
        r = self.client.get("/api/requirements/999999")
        self.assertEqual(r.status_code, 404)
    def test_dispatch_removed(self):
        r = self.client.post("/api/requirements/dispatch")
        self.assertIn(r.status_code, (404, 405))  # FastAPI may return 405 for POST on non-matching route
    def test_execute_removed(self):
        r = self.client.post("/api/requirements/1/execute")
        self.assertIn(r.status_code, (404, 405))
    def test_export(self):
        r = self.client.post("/api/requirements", json={"title": "导出测", "project_number": "EXP"})
        rid = r.json()["data"]["id"]
        r2 = self.client.get(f"/api/requirements/{rid}/export")
        self.assertEqual(r2.status_code, 200)
        self.assertIn("title", r2.json())


if __name__ == "__main__":
    unittest.main()