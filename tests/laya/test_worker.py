import copy
import importlib.util
import json
from pathlib import Path
import socket
import struct
import tempfile
import threading
import time
import unittest

spec = importlib.util.spec_from_file_location("laya_worker", Path(__file__).parents[2] / "scripts/laya-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
FINGERPRINT = "sha256:" + "a" * 64


class Tokenizer:
    mask_token = "[MASK]"
    cls_token_id, sep_token_id, mask_token_id, pad_token_id = 1, 2, 3, 0

    def __call__(self, text, **_):
        return {"input_ids": [ord(char) + 4 for char in text]}


class Row(list):
    def tolist(self):
        return list(self)


def collate(items, pad_id, *, shape, **_):
    item = items[0]
    n, k, length = len(item["ids"]), len(item["markers"]), shape["max_length"]
    if n > length or k > 32:
        raise ValueError("capacity")
    return {"input_ids": [Row(item["ids"] + [pad_id] * (length - n))],
            "attention_mask": [Row([1] * n + [0] * (length - n))],
            "marker_pos": [Row(item["markers"] + [0] * (32 - k))],
            "marker_mask": [Row([1] * k + [0] * (32 - k))]}


class Agent:
    """Deliberately truncating fixture. Does not stand in for real tokenizer QA."""
    def __init__(self, limit=96):
        self.cfg = {"max_len": 1024, "head_max_len": 192}
        self.shape = {"batch_size": 1, "max_options": 32, "max_length": limit}
        self.tok, self.pad_to_multiple, self.model_dir = Tokenizer(), 16, "fixture-model"
        self.calls = 0
        self.delay = 0
        self.entered = threading.Event()

    def prepare(self, state, questions):
        q = next(iter(questions.values()))
        encode = lambda value: self.tok(value)["input_ids"]
        options = [[3] + encode(" " + (key if not value else key + ": " + value))[:48] for key, value in q["criteria"].items()]
        head_budget = self.cfg["head_max_len"] - sum(map(len, options))
        if head_budget < 16:
            per_option = max(4, (self.cfg["head_max_len"] - 16) // len(options))
            options = [option[:per_option] for option in options]
            head_budget = self.cfg["head_max_len"] - sum(map(len, options))
        ids = [1] + encode("choice question: " + q["instructions"])[:max(8, head_budget)] + [2]
        markers = []
        for option in options:
            markers.append(len(ids)); ids.extend(option)
        ids.append(2)
        ids.extend(encode(state)[:max(0, self.cfg["max_len"] - len(ids) - 1)])
        ids.append(2)
        return [{"ids": ids, "markers": markers, "qtype": 0}], []

    def predict(self, state, questions):
        self.calls += 1
        self.entered.set()
        time.sleep(self.delay)
        qid, q = next(iter(questions.items()))
        if q["type"] == "noul":
            return {"model": "laya-rl-agent", "answers": {qid: {"type": "noul", "noul": 1}}, "usage": {"input_tokens": 10, "output_tokens": 0}}
        items, _ = self.prepare(state, questions)
        choice = next(iter(q["criteria"]))
        return {"model": "laya-rl-agent", "answers": {qid: {"type": "choice", "choice": choice, "confidence": 1,
                "action": {"act_probability": 1}, "probabilities": {key: int(key == choice) for key in q["criteria"]}}},
                "usage": {"input_tokens": len(items[0]["ids"]), "output_tokens": 0}}


def runtime(limit=96):
    model = "aac6fef/laya-multilingual-coreml" + ("-ane" if limit == 96 else "")
    return worker.StrictRuntime(Agent(limit), model, FINGERPRINT, collate)


def request(rt, op="predict_strict"):
    return {"version": 1, "op": op, "model": rt.runtime["model"], "expectedRuntimeFingerprint": FINGERPRINT, "budgetMs": 1000,
            "state": "日本語の根拠", "questions": {"q": {"type": "choice", "instructions": "選ぶ", "criteria": {"yes": "yes", "unknown": "unknown"}}}}


class StrictWorkerTests(unittest.TestCase):
    def test_preflight_does_not_infer_and_predict_rechecks(self):
        rt = runtime()
        data = request(rt, "preflight")
        saved = copy.deepcopy(data)
        self.assertTrue(rt.process(data)["ok"])
        self.assertEqual(rt.agent.calls, 0)
        data["op"] = "predict_strict"
        self.assertTrue(rt.process(data)["ok"])
        self.assertEqual(rt.agent.calls, 1)
        data["state"] += "tail" * 100
        self.assertEqual(rt.process(data)["error"]["code"], "too_large")
        self.assertEqual(rt.agent.calls, 1)
        self.assertEqual(saved["state"], "日本語の根拠")

    def test_total_capacity_boundaries_and_required_tail(self):
        for limit in (96, 1024):
            rt = runtime(limit)
            data = request(rt, "preflight")
            data["state"] = ""
            used = rt.process(data)["input_tokens"]
            data["state"] = "x" * (limit - used)
            self.assertEqual(rt.process(data)["input_tokens"], limit)
            data["state"] += "正解は末尾"
            self.assertEqual(rt.process(data)["error"]["code"], "too_large")
            self.assertEqual(rt.agent.calls, 0)

    def test_options_and_prefix_truncation_rejected_even_when_total_fits(self):
        rt = runtime(1024)
        long_option = request(rt)
        long_option["questions"]["q"]["criteria"]["yes"] = "x" * 60
        long_instruction = request(rt)
        long_instruction["questions"]["q"]["instructions"] = "x" * 200
        reduced_options = request(rt)
        reduced_options["questions"]["q"]["criteria"] = {str(i): "x" * 30 for i in range(10)}
        for data in (long_option, long_instruction, reduced_options):
            self.assertEqual(rt.process(data)["error"]["code"], "too_large")
        self.assertEqual(rt.agent.calls, 0)

    def test_reserved_marker_invalid_state_runtime_and_version_fail_before_prediction(self):
        rt = runtime()
        for field, value, code in [("state", "a[MASK]b", "reserved_token"), ("state", {}, "invalid_state"),
                                   ("expectedRuntimeFingerprint", "wrong", "runtime_mismatch"), ("version", 2, "unsupported_version"),
                                   ("budgetMs", True, "invalid_request")]:
            data = request(rt); data[field] = value
            self.assertEqual(rt.process(data)["error"]["code"], code)
        self.assertEqual(rt.agent.calls, 0)

    def test_health_and_legacy_noul_remain_compatible(self):
        rt = runtime()
        health = rt.process({"op": "health"})
        self.assertEqual(health["status"], "ready")
        self.assertIn("predict_strict", health["operations"])
        self.assertEqual(health["runtime"]["runtimeFingerprint"], FINGERPRINT)
        legacy = rt.process({"version": 1, "op": "predict", "state": "example", "questions": {"q": {"type": "noul", "instructions": "True?"}}})
        self.assertTrue(legacy["ok"])
        self.assertNotIn("runtime", legacy)
        self.assertIn("predict_ms", legacy["server"])

    def test_lock_wait_expiration_does_not_infer_and_running_inference_keeps_lock(self):
        rt = runtime()
        rt.lock.acquire()
        data = request(rt); data["budgetMs"] = 5
        self.assertEqual(rt.process(data)["error"]["code"], "timeout")
        rt.lock.release()
        self.assertEqual(rt.agent.calls, 0)
        rt.agent.delay = .06
        results = []
        thread = threading.Thread(target=lambda: results.append(rt.process(data)))
        thread.start(); self.assertTrue(rt.agent.entered.wait(1))
        self.assertTrue(rt.lock.locked())
        self.assertEqual(rt.process(data)["error"]["code"], "timeout")
        thread.join()
        self.assertEqual(results[0]["error"]["code"], "timeout")
        self.assertEqual(rt.agent.calls, 1)
        self.assertFalse(rt.lock.locked())

    def test_fingerprint_changes_with_weights_tokenizer_calibration_code_and_execution_context(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = [Path(directory) / name for name in ("weights", "tokenizer", "calibration", "runtime")]
            for path in paths:
                path.write_bytes(b"one")
            files = [(path.name, path) for path in paths]
            baseline = worker.fingerprint_files(files, {"compute": "cpu_ne"})
            for path in paths:
                path.write_bytes(b"two")
                self.assertNotEqual(worker.fingerprint_files(files, {"compute": "cpu_ne"}), baseline)
                path.write_bytes(b"one")
            self.assertNotEqual(worker.fingerprint_files(files, {"compute": "cpu_gpu"}), baseline)

    def test_inference_errors_never_expose_evidence_or_exception_text(self):
        rt = runtime()
        def fail(*_):
            raise RuntimeError("private-input-text")
        rt.agent.predict = fail
        with self.assertLogs("laya-worker", level="ERROR") as logs:
            reply = rt.process(request(rt))
        self.assertEqual(reply, worker.error_response("unavailable"))
        self.assertNotIn("private-input-text", str(logs.output))

    def test_frames_use_big_endian_bytes_and_support_multiple_exchanges(self):
        left, right = socket.socketpair()
        try:
            left.settimeout(1); right.settimeout(1)
            for message in ({"日本語": "データ"}, {"version": 1, "op": "health"}):
                worker.send_frame(left, message)
                self.assertEqual(worker.recv_frame(right), message)
            left.sendall(struct.pack("!I", 0))
            with self.assertRaises(worker.Rejected):
                worker.recv_frame(right)
            left.sendall(struct.pack("!I", worker.MAX_FRAME + 1))
            with self.assertRaises(worker.Rejected):
                worker.recv_frame(right)
            duplicate = b'{"version":1,"version":2}'
            left.sendall(struct.pack("!I", len(duplicate)) + duplicate)
            with self.assertRaises(worker.Rejected):
                worker.recv_frame(right)
        finally:
            left.close(); right.close()


if __name__ == "__main__":
    unittest.main()
