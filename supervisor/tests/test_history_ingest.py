import tempfile
import unittest
from pathlib import Path

from snooze.history_ingest import HistoryIngestor, ImportReceipt
from snooze.tasks import TaskRepository


class HistoryIngestTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = TaskRepository(Path(self.tmp.name) / 'history.sqlite')
        self.repo.register_project('p', '/work/p')
        self.ingestor = HistoryIngestor(self.repo, batch_size=2)

    def test_import_is_incremental_idempotent_and_cursor_durable(self):
        rows = [{'event_id': f'e{i}', 'at': 100+i, 'kind': 'activity', 'project_id': 'p'} for i in range(3)]
        first = self.ingestor.ingest_events('engine', 'page-1', rows)
        replay = self.ingestor.ingest_events('engine', 'page-1', rows)
        self.assertEqual(first, ImportReceipt('engine', 'page-1', 3, 0, 0, False))
        self.assertEqual((replay.accepted, replay.duplicates), (0, 3))
        with self.repo.connection() as conn:
            self.assertEqual(conn.execute('SELECT cursor FROM history_imports WHERE source_id="engine"').fetchone()[0], 'page-1')

    def test_cancellation_between_batches_keeps_resume_cursor_and_replays_safely(self):
        rows = [{'event_id': f'e{i}', 'at': 100+i, 'kind': 'activity', 'project_id': 'p'} for i in range(5)]
        checks = 0
        def cancelled():
            nonlocal checks
            checks += 1
            return checks == 2
        receipt = self.ingestor.ingest_events('engine', 'page-2', rows, cancelled=cancelled)
        self.assertTrue(receipt.cancelled)
        self.assertEqual(receipt.accepted, 2)
        self.assertEqual(receipt.cursor, None)
        with self.repo.connection() as conn:
            self.assertIsNone(conn.execute('SELECT cursor FROM history_imports WHERE source_id="engine"').fetchone())
        resumed = self.ingestor.ingest_events('engine', 'page-2', rows)
        self.assertEqual((resumed.accepted, resumed.duplicates), (3, 2))

    def test_transcripts_and_unknown_fields_are_not_persisted(self):
        row = {'event_id': 'private', 'at': 100, 'kind': 'usage', 'project_id': 'p',
               'input_tokens': 4, 'transcript': 'private prompt', 'authorization': 'secret',
               'custom_unknown': 'must not persist'}
        receipt = self.ingestor.ingest_events('engine', 'page-3', [row])
        self.assertEqual(receipt.accepted, 1)
        with self.repo.connection() as conn:
            stored = dict(conn.execute('SELECT * FROM history_facts').fetchone())
        self.assertNotIn('private prompt', str(stored))
        self.assertNotIn('secret', str(stored))
        self.assertNotIn('must not persist', str(stored))

    def test_invalid_rows_are_rejected_without_aborting_valid_rows(self):
        rows = [
            {'event_id': 'valid', 'at': 100, 'kind': 'activity', 'project_id': 'p'},
            {'event_id': '../bad', 'at': 'not-time', 'kind': 'activity', 'project_id': 'missing'},
        ]
        receipt = self.ingestor.ingest_events('engine', 'page-4', rows)
        self.assertEqual((receipt.accepted, receipt.rejected), (1, 1))
        self.assertIsNone(receipt.cursor)
        with self.repo.connection() as conn:
            self.assertIsNone(conn.execute('SELECT cursor FROM history_imports WHERE source_id="engine"').fetchone())

    def test_mixed_validity_page_does_not_advance_past_rejected_row(self):
        first = self.ingestor.ingest_events('engine', 'page-1', [
            {'event_id': 'ok-1', 'at': 100, 'kind': 'activity', 'project_id': 'p'}])
        second = self.ingestor.ingest_events('engine', 'page-2', [
            {'event_id': 'ok-2', 'at': 101, 'kind': 'activity', 'project_id': 'p'},
            {'event_id': 'bad', 'at': 'not-a-time', 'kind': 'activity', 'project_id': 'p'}])
        self.assertEqual(first.cursor, 'page-1')
        self.assertEqual(second.cursor, 'page-1')
        self.assertEqual((second.accepted, second.rejected), (1, 1))


if __name__ == '__main__':
    unittest.main()
