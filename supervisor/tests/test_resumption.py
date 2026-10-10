import json
import os
import sqlite3
import tempfile
import unittest
import uuid
from pathlib import Path

from snooze.resumption import ProcessTimedOut, ResumptionBroker, ResumptionError


class ResumptionBrokerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.workspace = self.root / "repo"
        self.workspace.mkdir()
        self.claude_config = self.root / "fixed-mcp.json"
        self.claude_config.write_text('{"mcpServers":{}}')
        self.codex_exe = self.root / "codex"
        self.claude_exe = self.root / "claude"
        for exe in (self.codex_exe, self.claude_exe):
            exe.write_text("#!/bin/sh\nexit 0\n")
            exe.chmod(0o700)
        self.db = self.root / "private" / "requests.sqlite"
        self.calls = []
        self.runner = self.fake_runner
        self.broker = self.new_broker()
        self.session_id = str(uuid.uuid4())
        self.register(adapter="codex")
        self.policy()

    def tearDown(self):
        if getattr(self, "broker", None):
            self.broker.close()
        self.temp.cleanup()

    def new_broker(self, runner=None):
        return ResumptionBroker(self.db, executables={"codex": str(self.codex_exe), "claude": str(self.claude_exe)},
                                process_runner=runner or self.runner)

    def fake_runner(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        return {"exit_code": 0, "stdout_bytes": 340, "stderr_bytes": 7,
                "output_truncated": False, "stdout": "PRIVATE TRANSCRIPT SHOULD NOT PERSIST",
                "stderr": "PRIVATE ERROR SHOULD NOT PERSIST"}

    def register(self, *, adapter, job="job-1"):
        if job != "job-1":
            self.session_id = str(uuid.uuid4())
        self.broker.register_session(
            session_id=self.session_id, principal_id="principal-1", project_id="project-1", job_id=job,
            adapter=adapter, workspace_cwd=str(self.workspace), model="haiku" if adapter == "claude" else "codex-safe",
            strict_mcp_config=str(self.claude_config) if adapter == "claude" else None,
            allowed_tools=["Read", "mcp__tasks__get"] if adapter == "claude" else (),
        )

    def policy(self, *, level=4, mode="headless", actions=("resume",), ack=True,
               attempts=2, per_attempt=0.25, ceiling=1.00):
        self.broker.configure_policy(
            principal_id="principal-1", project_id="project-1", authorization_level=level,
            mode=mode, allowed_actions=actions, max_attempts=attempts, max_runtime_seconds=9,
            attempt_budget_usd=per_attempt, budget_ceiling_usd=ceiling,
            codex_runtime_budget_ack=ack,
        )

    def event(self, event_id="evt-1", *, job="job-1", prompt="Continue the registered task safely."):
        return self.broker.handle_event(event_id=event_id, principal_id="principal-1", project_id="project-1",
                                        job_id=job, action="resume", prompt=prompt)

    def test_codex_invocation_uses_fixed_argv_no_shell_and_redacts_output(self):
        os.environ["ANTHROPIC_API_KEY"] = "never-forward-this"
        try:
            result = self.event(prompt="Private event prompt")
        finally:
            os.environ.pop("ANTHROPIC_API_KEY", None)
        self.assertEqual(result["state"], "completed")
        argv, options = self.calls[0]
        self.assertEqual(argv, [str(self.codex_exe), "exec", "resume", "--model", "codex-safe", "--json",
                                self.session_id, "Private event prompt"])
        self.assertIs(options["shell"], False)
        self.assertIs(options["start_new_session"], True)
        self.assertNotIn("ANTHROPIC_API_KEY", options["env"])
        self.assertEqual(options["timeout"], 9)
        self.assertEqual(options["output_limit"], 64 * 1024)
        self.assertEqual(result["summary"]["budget_enforcement"], "runtime_acknowledged_not_cli_enforced")
        self.assertNotIn("stdout", result["summary"])
        self.assertNotIn("Private event prompt", json.dumps(result))
        with sqlite3.connect(self.db) as c:
            saved = c.execute("SELECT summary_json FROM resumption_requests WHERE event_id='evt-1'").fetchone()[0]
            schema = {row[1] for row in c.execute("PRAGMA table_info(resumption_requests)")}
        self.assertNotIn("PRIVATE TRANSCRIPT", saved)
        self.assertNotIn("PRIVATE ERROR", saved)
        self.assertNotIn("prompt", schema)

    def test_duplicate_event_invokes_once_and_ack_is_separate_from_completion(self):
        first = self.event()
        duplicate = self.event()
        self.assertEqual(first["state"], "completed")
        self.assertTrue(duplicate["deduplicated"])
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(duplicate["acked"])
        self.assertTrue(self.broker.acknowledge("evt-1"))
        after_ack = self.broker.get_event("evt-1")
        self.assertTrue(after_ack["acked"])
        self.assertEqual(after_ack["state"], "completed")

    def test_unqualified_or_disallowed_policy_never_invokes_cli(self):
        self.policy(level=3)
        result = self.event()
        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["error_code"], "policy_level_not_authorized")
        self.assertEqual(self.calls, [])
        second = self.broker.handle_event(event_id="evt-2", principal_id="principal-1", project_id="project-1",
                                          job_id="job-1", action="resume", prompt="This must not start")
        self.assertEqual(second["state"], "failed")

    def test_observe_default_and_chatgpt_web_create_durable_handoffs(self):
        self.policy(mode="observe")
        observed = self.event()
        self.assertEqual(observed["state"], "manual_handoff")
        self.assertEqual(self.broker.pending_handoffs()[0]["event_id"], "evt-1")
        self.assertTrue(self.broker.acknowledge("evt-1"))
        self.assertEqual(self.broker.get_event("evt-1")["state"], "manual_handoff")
        self.broker.close()
        self.broker = self.new_broker()
        self.register(adapter="chatgpt_web")
        self.policy(mode="headless")
        web = self.event("evt-web")
        self.assertEqual(web["state"], "manual_handoff")
        self.assertEqual(web["error_code"], "web_session_requires_human")
        self.assertEqual(len(self.calls), 0)

    def test_unknown_codex_cli_budget_blocks_without_explicit_bounded_runtime_ack(self):
        self.policy(ack=False)
        result = self.event()
        self.assertEqual(result["state"], "manual_handoff")
        self.assertEqual(result["error_code"], "codex_budget_not_enforceable")
        self.assertEqual(self.calls, [])

    def test_project_budget_ceiling_is_reserved_and_enforced_across_jobs(self):
        self.policy(per_attempt=0.25, ceiling=0.25)
        self.assertEqual(self.event("evt-first")["state"], "completed")
        self.register(adapter="codex", job="job-2")
        second = self.event("evt-second", job="job-2")
        self.assertEqual(second["state"], "manual_handoff")
        self.assertEqual(second["error_code"], "budget_ceiling_reached")
        self.assertEqual(len(self.calls), 1)

    def test_claude_command_has_budget_strict_config_and_registered_tools(self):
        self.broker.close()
        self.broker = self.new_broker()
        self.register(adapter="claude")
        self.policy(ack=False)
        result = self.event()
        self.assertEqual(result["state"], "completed")
        argv, options = self.calls[0]
        self.assertEqual(argv, [str(self.claude_exe), "-p", "--resume", self.session_id,
                                "Continue the registered task safely.", "--model", "haiku",
                                "--max-budget-usd", "0.25", "--strict-mcp-config", str(self.claude_config),
                                "--allowedTools", "Read", "mcp__tasks__get", "--output-format", "json"])
        self.assertIs(options["shell"], False)
        self.assertNotIn("--dangerously-skip-permissions", argv)

    def test_timeout_is_ambiguous_and_duplicate_or_restart_never_replays(self):
        def timeout_runner(argv, **kwargs):
            self.calls.append((argv, kwargs))
            raise ProcessTimedOut(10, 2, False)
        self.broker.close()
        self.broker = self.new_broker(runner=timeout_runner)
        self.register(adapter="codex")
        self.policy()
        result = self.event()
        self.assertEqual(result["state"], "ambiguous")
        self.assertEqual(self.event()["state"], "ambiguous")
        self.assertEqual(len(self.calls), 1)
        self.broker.close()
        self.broker = self.new_broker(runner=timeout_runner)
        self.assertEqual(self.event()["state"], "ambiguous")
        self.assertEqual(len(self.calls), 1)

    def test_restart_conservatively_marks_unfinished_claim_ambiguous(self):
        request = self.event()
        request_id = request["request_id"]
        # Simulate a crash after the durable claim but before terminal persistence.
        with sqlite3.connect(self.db) as c:
            c.execute("UPDATE resumption_requests SET state='claimed',attempts=2,budget_reserved_cents=25 WHERE request_id=?", (request_id,))
            c.execute("UPDATE resumption_policies SET reserved_cents=25,spent_cents=0 WHERE principal_id='principal-1'")
            c.execute("INSERT INTO resumption_attempts(request_id,attempt_no,owner_pid,state,started_at) VALUES(?,2,1,'claimed',1)", (request_id,))
        self.broker.close()
        self.broker = self.new_broker()
        recovered = self.broker.get_request(request_id)
        self.assertEqual(recovered["state"], "ambiguous")
        self.assertEqual(recovered["error_code"], "owner_restart_ambiguous")
        self.assertEqual(self.event()["state"], "ambiguous")
        self.assertEqual(len(self.calls), 1)

    def test_event_id_conflict_and_prompt_option_injection_are_rejected(self):
        self.event()
        with self.assertRaisesRegex(ResumptionError, "event_id_conflict"):
            self.broker.handle_event(event_id="evt-1", principal_id="other", project_id="project-1",
                                     job_id="job-1", action="resume", prompt="Different event")
        with self.assertRaisesRegex(ResumptionError, "invalid_prompt"):
            self.event("evt-options", prompt=" --dangerously-skip-permissions")
        self.assertEqual(len(self.calls), 1)


if __name__ == "__main__":
    unittest.main()
