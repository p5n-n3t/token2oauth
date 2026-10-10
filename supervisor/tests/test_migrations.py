import sqlite3
from contextlib import closing
import tempfile
import unittest
from pathlib import Path
from snooze.store import Store
from snooze.migrations import migrate_state
from snooze.tasks import TaskRepository


class MigrationTests(unittest.TestCase):
    def test_backup_retains_preview_history_and_replay_is_idempotent(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'state.sqlite'
            store = Store(path)
            store.ingest_jobs('p', [{'id': 'a', 'session_id': 's'}])
            store.observe('s', {'status': 'idle'})
            store.incident('p', 'a', 'idle', 'No result')
            first = migrate_state(path)
            self.assertTrue(first.backup_path.exists())
            with closing(sqlite3.connect(first.backup_path)) as c:
                self.assertEqual(c.execute('SELECT COUNT(*) FROM jobs').fetchone()[0], 1)
                self.assertEqual(c.execute('SELECT COUNT(*) FROM observations').fetchone()[0], 1)
                self.assertEqual(c.execute('SELECT COUNT(*) FROM incidents').fetchone()[0], 1)
            second = migrate_state(path)
            self.assertFalse(second.changed)
            self.assertEqual(Store(path).snapshot('p')['workers'][0]['id'], 'a')

    def test_failed_migration_rolls_back(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'state.sqlite'
            store = Store(path); store.ingest_jobs('p', [{'id': 'a'}])
            def fail(connection):
                connection.execute('CREATE TABLE must_not_persist(x)')
                raise RuntimeError('fixture failure')
            with self.assertRaises(RuntimeError): migrate_state(path, before_commit=fail)
            with closing(sqlite3.connect(path)) as c:
                self.assertIsNone(c.execute("SELECT name FROM sqlite_master WHERE name='must_not_persist'").fetchone())
            self.assertEqual(Store(path).snapshot('p')['workers'][0]['id'], 'a')

    def test_version_one_database_upgrades_only_by_adding_metrics_tables(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'state.sqlite'
            repo = TaskRepository(path)
            repo.register_project('p', '/p')
            with repo.connection(True) as c:
                c.execute("INSERT INTO tasks(id,project,spec,instructions,state,created_at,updated_at) VALUES('t','p','{}','','queued',10,10)")
                c.execute('DROP TABLE history_facts')
                c.execute('DROP TABLE history_imports')
                c.execute('DELETE FROM schema_versions WHERE version=2')
            with closing(sqlite3.connect(path)) as c:
                c.execute('PRAGMA user_version=1')
                c.commit()
            report = migrate_state(path)
            self.assertTrue(report.changed)
            self.assertEqual(report.version, 2)
            with repo.connection() as c:
                self.assertEqual(c.execute('SELECT id FROM tasks').fetchone()[0], 't')
                self.assertIsNotNone(c.execute("SELECT name FROM sqlite_master WHERE name='history_facts'").fetchone())
                self.assertIsNotNone(c.execute("SELECT name FROM sqlite_master WHERE name='history_imports'").fetchone())
