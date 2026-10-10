import tempfile
import unittest
from pathlib import Path

from snooze.jobs import JobRegistry, validate_assignment


def assignment(assignment_id="job-1", key="key-1", tasks=None):
    return {
        "schemaVersion": 1,
        "assignmentId": assignment_id,
        "idempotencyKey": key,
        "projectId": "project-a",
        "eligibleAccountIds": ["account-a", "account-b"],
        "tasks": tasks or [{
            "taskId": "task-1", "dependsOn": [], "scopeKeys": ["path:src/input.json"],
            "inputRef": "artifact:input-1", "inputSha256": "a" * 64,
            "instructions": "Extract records", "execution": {"mode": "fresh", "provider": "codex"},
            "output": {"kind": "text", "maxBytes": 1024, "format": "plain"},
        }],
    }


class JobRegistryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "private" / "jobs.sqlite3"
        self.registry = JobRegistry(self.db)

    def tearDown(self):
        self.temp.cleanup()

    def test_submission_is_durable_and_idempotent(self):
        body = assignment()
        first = self.registry.submit(body, now=10)
        reopened = JobRegistry(self.db)
        retry = reopened.submit(body, now=11)
        self.assertEqual(first, retry)
        self.assertEqual(reopened.get_assignment("job-1")["state"], "queued")
        changed = assignment(assignment_id="job-2")
        with self.assertRaisesRegex(ValueError, "Idempotency"):
            reopened.submit(changed)

    def test_dag_is_bounded_and_cycles_are_rejected(self):
        tasks = assignment()["tasks"]
        tasks[0]["dependsOn"] = ["task-2"]
        tasks.append({**assignment()["tasks"][0], "taskId": "task-2", "dependsOn": ["task-1"]})
        with self.assertRaisesRegex(ValueError, "cycle"):
            validate_assignment(assignment(tasks=tasks))
        too_many = assignment()
        too_many["tasks"] = [assignment()["tasks"][0] for _ in range(101)]
        with self.assertRaisesRegex(ValueError, "1 to 100"):
            validate_assignment(too_many)

    def test_claim_persists_account_affinity_and_operation_before_return(self):
        self.registry.submit(assignment(), now=100)
        op = self.registry.claim_operation("node-1", now=101)
        self.assertIn(op["selectedAccountId"], {"account-a", "account-b"})
        with self.registry.connection() as db:
            row = db.execute("SELECT state,account,generation FROM operations WHERE id=?", (op["operationId"],)).fetchone()
        self.assertEqual((row["state"], row["account"], row["generation"]), ("claimed", op["selectedAccountId"], 1))
        snapshot = self.registry.get_assignment("job-1")["tasks"][0]
        self.assertEqual(snapshot["selectedAccountId"], op["selectedAccountId"])

    def test_expired_mutation_is_ambiguous_and_never_requeued(self):
        self.registry.submit(assignment(), now=100)
        op = self.registry.claim_operation("node-1", lease_seconds=5, now=101)
        self.assertIsNone(self.registry.claim_operation("node-2", now=107))
        with self.registry.connection() as db:
            state = db.execute("SELECT state FROM operations WHERE id=?", (op["operationId"],)).fetchone()[0]
        self.assertEqual(state, "ambiguous")
        self.assertEqual(self.registry.get_assignment("job-1")["tasks"][0]["state"], "ambiguous")

    def test_result_replay_is_idempotent_but_conflict_is_rejected(self):
        self.registry.submit(assignment(), now=1)
        op = self.registry.claim_operation("node-1", now=2)
        body = {"workerId": "node-1", "outcome": "accepted", "result": {"providerTaskId": "remote-1"}}
        first = self.registry.record_result(op["operationId"], body, now=3)
        self.assertFalse(first["replayed"])
        self.assertTrue(self.registry.record_result(op["operationId"], body, now=4)["replayed"])
        conflict = {**body, "result": {"providerTaskId": "remote-2"}}
        with self.assertRaisesRegex(RuntimeError, "Conflicting"):
            self.registry.record_result(op["operationId"], conflict)
        next_op = self.registry.claim_operation("node-1", now=5)
        self.assertEqual(next_op["kind"], "patch_task")
        self.assertEqual(next_op["selectedAccountId"], op["selectedAccountId"])

    def test_control_revision_fences_pause_and_quota_are_unknown(self):
        self.registry.submit(assignment(), now=1)
        self.registry.set_control("pause_dispatch", True, expected_revision=1)
        self.assertIsNone(self.registry.claim_operation("node-1", now=2))
        self.registry.set_control("pause_dispatch", False, expected_revision=2)
        op = self.registry.claim_operation("node-1", now=3)
        self.assertEqual(self.registry.get_assignment("job-1")["tasks"][0]["quota"], "unknown")
        self.assertIsNotNone(op)

    def test_pause_fences_an_operation_already_in_the_outbox(self):
        self.registry.submit(assignment(), now=1)
        first = self.registry.claim_operation("node-1", now=2)
        self.registry.record_result(first["operationId"], {
            "workerId": "node-1", "outcome": "accepted", "result": {"providerTaskId": "remote-1"}}, now=3)
        self.registry.set_control("pause_dispatch", True, expected_revision=1)
        self.assertIsNone(self.registry.claim_operation("node-1", now=4))
        self.registry.set_control("pause_dispatch", False, expected_revision=2)
        following = self.registry.claim_operation("node-1", now=5)
        self.assertEqual(following["kind"], "patch_task")

    def test_snapshot_and_events_do_not_return_instructions(self):
        body = assignment()
        body["tasks"][0]["instructions"] = "private instruction content"
        self.registry.submit(body, now=9)
        serialized = str(self.registry.get_assignment("job-1")) + str(self.registry.events())
        self.assertNotIn("private instruction", serialized)

    def test_credential_like_instruction_is_rejected_before_persistence(self):
        body = assignment()
        body["tasks"][0]["instructions"] = "Bearer sensitive-value"
        with self.assertRaisesRegex(ValueError, "Credential-like"):
            self.registry.submit(body)


if __name__ == "__main__":
    unittest.main()
