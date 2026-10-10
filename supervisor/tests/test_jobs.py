import tempfile
import unittest
from pathlib import Path

from snooze.jobs import JobRegistry, validate_assignment


def task(task_id="task-1", *, account="account-a", depends=None, scope=None):
    return {
        "taskId": task_id, "dependsOn": depends or [], "scopeKeys": [scope or f"path:src/{task_id}.txt"],
        "instructions": f"Do bounded work for {task_id}",
        "execution": {"mode": "existing-session", "sessionId": f"session-{account}", "accountId": account},
        "output": {"kind": "text", "maxBytes": 1024, "format": "plain", "expectedMarker": "DONE"},
    }


def assignment(assignment_id="job-1", key="key-1", tasks=None, *, accounts=None, max_workers=3):
    return {
        "schemaVersion": 1, "assignmentId": assignment_id, "idempotencyKey": key,
        "projectId": "project-a", "eligibleAccountIds": accounts or ["account-a"], "maxWorkers": max_workers,
        "tasks": tasks or [task()],
    }


class JobRegistryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "private" / "jobs.sqlite3"
        self.registry = JobRegistry(self.db)
        self.register("account-a")

    def register(self, account, *, enabled=True, authorized=True, health="healthy", quota="available", sessions=None):
        return self.registry.register_account({
            "accountId": account, "enabled": enabled, "authorized": authorized, "health": health,
            "quota": quota, "allowUnknownQuota": False,
            "registeredSessions": sessions or [{"id": f"session-{account}", "model": "unknown", "workspace": "workspace-a"}],
        })

    def tearDown(self):
        self.temp.cleanup()

    def complete_one(self, assignment_id="job-1", now=10):
        operation = self.registry.claim_operation("node-1", now=now)
        self.assertEqual(operation["kind"], "chat_session")
        self.registry.record_result(operation["operationId"], {"workerId": "node-1", "outcome": "accepted"}, now=now + 1)
        observation = self.registry.claim_operation("node-1", now=now + 3)
        self.assertEqual(observation["kind"], "observe_session")
        self.registry.record_result(observation["operationId"], {"workerId": "node-1", "outcome": "accepted", "result": {
            "status": "complete", "assistantText": "DONE result", "assistantAt": now + 2,
            "reportedModel": "model-a", "sessionId": operation["sessionId"]}}, now=now + 4)

    def test_submission_is_durable_and_idempotent(self):
        body = assignment()
        first = self.registry.submit(body, now=10)
        reopened = JobRegistry(self.db)
        self.register("account-a")
        retry = reopened.submit(body, now=11)
        self.assertEqual(first, retry)
        self.assertEqual(reopened.get_assignment("job-1")["state"], "queued")
        changed = assignment(assignment_id="job-2")
        with self.assertRaisesRegex(ValueError, "Idempotency"):
            reopened.submit(changed)

    def test_single_account_and_ordinary_task_without_input_hash_are_valid(self):
        body = assignment(accounts=["account-a"])
        self.assertNotIn("inputSha256", validate_assignment(body)["tasks"][0])
        self.registry.submit(body, now=1)
        operation = self.registry.claim_operation("node-1", now=2)
        self.assertEqual(operation["selectedAccountId"], "account-a")
        self.assertEqual(operation["input"]["instructions"], "Do bounded work for task-1")
        self.assertEqual(operation["input"]["sessionId"], "session-account-a")

    def test_dag_is_bounded_and_cycles_are_rejected(self):
        tasks = [task("task-1", depends=["task-2"]), task("task-2", depends=["task-1"])]
        with self.assertRaisesRegex(ValueError, "cycle"):
            validate_assignment(assignment(tasks=tasks))
        too_many = [task(f"task-{i}") for i in range(101)]
        with self.assertRaisesRegex(ValueError, "1 to 100"):
            validate_assignment(assignment(tasks=too_many))

    def test_assistant_requires_fresh_timestamp_marker_and_bounded_text(self):
        self.registry.submit(assignment(), now=1)
        chat = self.registry.claim_operation("node-1", now=2)
        self.assertEqual(chat["kind"], "chat_session")
        self.assertIn("dispatchAt", chat["input"])
        self.registry.record_result(chat["operationId"], {"workerId": "node-1", "outcome": "accepted"}, now=3)
        observe = self.registry.claim_operation("node-1", now=5)
        stale = {"workerId": "node-1", "outcome": "accepted", "result": {"status": "complete", "assistantText": "DONE old", "assistantAt": 1, "sessionId": "session-account-a"}}
        self.registry.record_result(observe["operationId"], stale, now=6)
        self.assertEqual(self.registry.get_assignment("job-1")["tasks"][0]["state"], "awaiting_output")
        observe = self.registry.claim_operation("node-1", now=8)
        fresh = {"workerId": "node-1", "outcome": "accepted", "result": {"status": "complete", "assistantText": "DONE verified", "assistantAt": 7, "reportedModel": "model-a", "sessionId": "session-account-a"}}
        self.registry.record_result(observe["operationId"], fresh, now=9)
        self.assertEqual(self.registry.get_assignment("job-1")["tasks"][0]["state"], "complete")
        output = self.registry.assignment_results("job-1")["results"][0]
        self.assertEqual(output["text"], "DONE verified")

    def test_validated_dependency_unlocks_child(self):
        body = assignment(tasks=[task("first"), task("second", depends=["first"])])
        self.registry.submit(body, now=1)
        self.complete_one(now=2)
        nxt = self.registry.claim_operation("node-1", now=7)
        self.assertEqual(nxt["kind"], "chat_session")
        self.assertEqual(nxt["input"]["sessionId"], "session-account-a")

    def test_scope_conflict_across_jobs_blocks_second_until_release(self):
        self.registry.submit(assignment(), now=1)
        first = self.registry.claim_operation("node-1", now=2)
        self.registry.submit(assignment("job-2", "key-2", [task("other", scope="path:src/task-1.txt/child")]), now=3)
        self.registry.record_result(first["operationId"], {"workerId": "node-1", "outcome": "accepted"}, now=4)
        observe = self.registry.claim_operation("node-1", now=5)
        self.registry.record_result(observe["operationId"], {"workerId": "node-1", "outcome": "accepted", "result": {
            "status": "complete", "assistantText": "DONE", "assistantAt": 4, "sessionId": "session-account-a"}}, now=6)
        self.assertEqual(self.registry.claim_operation("node-1", now=7)["kind"], "chat_session")

    def test_existing_snooze_attempt_reserves_overlapping_scope(self):
        self.register("account-b")
        with self.registry.connection(write=True) as db:
            db.execute("INSERT INTO attempts(id,task,project,account,generation,idempotency_key,state,scopes,started_at,data) VALUES(?,?,?,?,?,?,?,?,?,?)",
                       ("snooze-attempt", "existing-task", "project-a", "other-account", 1, "existing-key", "running",
                        '["path:src/task-1.txt/subtree"]', 1, "{}"))
        self.registry.submit(assignment(accounts=["account-b"], tasks=[task("new", account="account-b", scope="path:src/task-1.txt")]), now=2)
        self.assertIsNone(self.registry.claim_operation("node-1", now=3))

    def test_account_is_revalidated_immediately_before_claim(self):
        self.registry.submit(assignment(), now=1)
        with self.registry.connection(write=True) as db:
            self.registry._queue_one_ready(db, 1.5)
        self.register("account-a", enabled=False)
        with self.assertRaisesRegex(RuntimeError, "disabled"):
            self.registry.claim_operation("node-1", now=2)

    def test_unknown_quota_requires_explicit_acknowledgement(self):
        self.register("account-b", quota="unknown")
        with self.assertRaisesRegex(RuntimeError, "quota"):
            self.registry.submit(assignment(accounts=["account-b"], tasks=[task(account="account-b")]), now=1)
        self.registry.register_account({"accountId": "account-b", "enabled": True, "authorized": True,
            "health": "healthy", "quota": "unknown", "allowUnknownQuota": True,
            "registeredSessions": [{"id": "session-account-b", "model": "unknown", "workspace": "workspace-a"}]})
        self.registry.submit(assignment("job-b", "key-b", [task(account="account-b")], accounts=["account-b"]), now=2)

    def test_thirty_five_tasks_share_nine_accounts_with_three_worker_ceiling(self):
        accounts = [f"acct-{i}" for i in range(9)]
        for account in accounts:
            self.register(account)
        tasks = [task(f"task-{i}", account=accounts[i % len(accounts)]) for i in range(35)]
        self.registry.submit(assignment("many", "many-key", tasks, accounts=accounts, max_workers=3), now=1)
        now, active, peak, completed = 2, 0, 0, 0
        seen_accounts = set()
        while completed < len(tasks) and now < 1000:
            op = self.registry.claim_operation("worker", now=now)
            now += 1
            if op is None:
                continue
            seen_accounts.add(op["selectedAccountId"])
            if op["kind"] == "chat_session":
                active += 1
                peak = max(peak, active)
                self.registry.record_result(op["operationId"], {"workerId": "worker", "outcome": "accepted"}, now=now)
            else:
                self.registry.record_result(op["operationId"], {"workerId": "worker", "outcome": "accepted", "result": {
                    "status": "complete", "assistantText": "DONE", "assistantAt": now - 2, "sessionId": op["sessionId"]}}, now=now)
                active -= 1
                completed += 1
        self.assertEqual(completed, 35)
        self.assertEqual(seen_accounts, set(accounts))
        self.assertLessEqual(peak, 3)

    def test_expired_chat_is_ambiguous_and_never_duplicated(self):
        self.registry.submit(assignment(), now=1)
        op = self.registry.claim_operation("node-1", lease_seconds=5, now=2)
        self.assertIsNone(self.registry.claim_operation("node-2", now=8))
        with self.registry.connection() as db:
            self.assertEqual(db.execute("SELECT state FROM operations WHERE id=?", (op["operationId"],)).fetchone()[0], "ambiguous")
        self.assertEqual(self.registry.get_assignment("job-1")["tasks"][0]["state"], "ambiguous")

    def test_pause_control_blocks_previously_queued_claim(self):
        self.registry.submit(assignment(), now=1)
        self.registry.set_control("pause_dispatch", True, expected_revision=1)
        self.assertIsNone(self.registry.claim_operation("node-1", now=2))
        self.registry.set_control("pause_dispatch", False, expected_revision=2)
        self.assertEqual(self.registry.claim_operation("node-1", now=3)["kind"], "chat_session")

    def test_cancel_fences_generation_and_retains_remote_ownership(self):
        self.registry.submit(assignment(), now=1)
        op = self.registry.claim_operation("node-1", now=2)
        self.registry.cancel_assignment("job-1", expected_revision=1, now=3)
        with self.registry.connection() as db:
            row = db.execute("SELECT state,generation,released_at FROM job_tasks WHERE assignment='job-1'").fetchone()
            operation_state = db.execute("SELECT state FROM operations WHERE id=?", (op["operationId"],)).fetchone()[0]
            attempt = db.execute("SELECT released_at FROM attempts WHERE id=?", (op["attemptId"],)).fetchone()
        self.assertEqual((row["state"], row["generation"], row["released_at"]), ("cancel_pending", 2, None))
        self.assertEqual(operation_state, "ambiguous")
        self.assertIsNone(attempt["released_at"])

    def test_private_results_and_owner_filtering(self):
        body = assignment()
        body["ownerPrincipalId"] = "alice"
        body["clientId"] = "client-a"
        self.registry.submit(body, now=1)
        self.assertIsNone(self.registry.get_assignment("job-1", "bob"))
        self.assertEqual(self.registry.get_assignment("job-1", "alice", "client-a")["assignmentId"], "job-1")
        self.assertIsNone(self.registry.get_assignment("job-1", "alice", "different-client"))
        with self.assertRaises(KeyError):
            self.registry.assignment_results("job-1", "bob")

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
