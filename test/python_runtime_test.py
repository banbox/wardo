"""Run with: python -m unittest test.python_runtime_test (Python 3.10+)."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "python"))
from wardo import (  # noqa: E402
    TaskResult, WardoConfig, WardoStore, WorkflowSpec, TaskSpec,
    TaskAgent, WorkflowRunner, LlmRegistry, ProviderConfig,
)


class FakeAdapter:
    def start(self, prompt, cwd, model=None):
        return {"provider": "codex", "sessionId": "fake", "cwd": cwd}

    def resume(self, session, prompt, model=None):
        return session

    def run(self, session, prompt, model=None):
        yield "done"


class FakeRegistry:
    def generate(self, role, prompt, schema=None, model=None, max_retries=None):
        return {"object": {"verdict": "pass", "reason": "ok", "retryable": False, "missing": []}, "text": "ok"}


class RuntimeTests(unittest.TestCase):
    def test_nested_dag_and_independent_judge(self):
        with tempfile.TemporaryDirectory() as directory:
            store = WardoStore(directory)
            config = WardoConfig(max_concurrency=2, providers={"openai": ProviderConfig()}, provider_order=["openai"])
            agent = TaskAgent({"codex": FakeAdapter()}, FakeRegistry(), config, store)
            workflow = WorkflowSpec("test", "test", [
                TaskSpec("root", "root", "done", children=[TaskSpec("child", "child", "done")]),
                TaskSpec("last", "last", "done", depends_on=["child"]),
            ])
            result = WorkflowRunner(workflow, agent, store, config).run()
            self.assertEqual(result["last"].status, "succeeded")
            self.assertTrue((Path(directory) / ".wardo/tasks/root/attempt-0001/judge.json").exists())

    def test_openai_and_anthropic_wire_formats(self):
        calls = []

        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self):
                if calls[-1]["url"].endswith("messages"):
                    return b'{"content":[{"text":"{\\"ok\\":true}"}]}'
                return b'{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}'

        def opener(request, timeout=0):
            calls.append({"url": request.full_url, "body": request.data})
            return Response()

        config = WardoConfig(providers={
            "openai": ProviderConfig("openai", base_url="https://example.test/v1"),
            "anthropic": ProviderConfig("anthropic", base_url="https://example.test/v1"),
        }, provider_order=["openai", "anthropic"], retry=__import__("wardo").RetryPolicy([0], 1))
        registry = LlmRegistry(config, opener=opener)
        registry.generate("general", "hello", {"ok": "boolean"}, "openai:gpt-test")
        registry.generate("general", "hello", {"ok": "boolean"}, "anthropic:claude-test")
        self.assertTrue(any(url.endswith("chat/completions") for url in [x["url"] for x in calls]))
        self.assertTrue(any(url.endswith("messages") for url in [x["url"] for x in calls]))


if __name__ == "__main__":
    unittest.main()
