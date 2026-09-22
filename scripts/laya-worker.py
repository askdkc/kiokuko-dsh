#!/usr/bin/env python3
"""User-managed Laya worker. No downloads; legacy v1 plus strict finite decisions.

Prompt layout follows laya-coreml's Apache-2.0 PromptMixin (see THIRD_PARTY_NOTICES).
The strict path independently constructs the complete input, then compares the
installed runtime's preparation and collated arrays before allowing inference.
"""
import concurrent.futures
import hashlib
import importlib.metadata
import json
import logging
import math
import os
from pathlib import Path
import platform
import signal
import socket
import stat
import struct
import threading
import time

VERSION = 1
MAX_FRAME = 1024 * 1024
DECISION_BYTES = 256 * 1024
MAX_CLIENTS = 8
MODEL_LIMITS = {
    "aac6fef/laya-multilingual-coreml": 1024,
    "aac6fef/laya-multilingual-coreml-ane": 96,
}
SOCKET_DEFAULT = "~/Library/Caches/laya-coreml/worker.sock"
LOG = logging.getLogger("laya-worker")


class Rejected(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def error_response(code):
    return {"version": VERSION, "ok": False, "error": {"code": code}}


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def recv_exact(conn, size):
    data = bytearray()
    while len(data) < size:
        chunk = conn.recv(size - len(data))
        if not chunk:
            raise EOFError
        data.extend(chunk)
    return bytes(data)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Rejected("invalid_request")
        result[key] = value
    return result


def reject_constant(_value):
    raise Rejected("invalid_request")


def recv_frame(conn):
    length = struct.unpack("!I", recv_exact(conn, 4))[0]
    if not 0 < length <= MAX_FRAME:
        raise Rejected("protocol_error")
    try:
        return json.loads(recv_exact(conn, length).decode("utf-8"), object_pairs_hook=unique_object, parse_constant=reject_constant)
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise Rejected("invalid_request") from exc


def send_frame(conn, value):
    payload = json_bytes(value)
    if not 0 < len(payload) <= MAX_FRAME:
        raise Rejected("protocol_error")
    conn.sendall(struct.pack("!I", len(payload)) + payload)


def strict_question(state, questions):
    if not isinstance(state, str) or not isinstance(questions, dict) or len(questions) != 1:
        raise Rejected("invalid_input")
    qid, question = next(iter(questions.items()))
    if not isinstance(qid, str) or not qid or not isinstance(question, dict):
        raise Rejected("invalid_input")
    if set(question) != {"type", "instructions", "criteria"} or question["type"] != "choice":
        raise Rejected("invalid_input")
    if not isinstance(question["instructions"], str) or not question["instructions"]:
        raise Rejected("invalid_input")
    criteria = question["criteria"]
    if not isinstance(criteria, dict) or len(criteria) < 2:
        raise Rejected("invalid_input")
    if len(criteria) > 32:
        raise Rejected("too_large")
    if any(not isinstance(k, str) or not k or not isinstance(v, str) for k, v in criteria.items()):
        raise Rejected("invalid_input")
    return question


class StrictRuntime:
    """Own one loaded agent and serialize all tokenizer/model access."""
    def __init__(self, agent, model_id, fingerprint, collate):
        self.agent, self.collate = agent, collate
        self.lock = threading.Lock()
        self.started = time.monotonic()
        shape = agent.shape
        limit = min(agent.cfg.get("max_len", 512), shape["max_length"])
        if model_id not in MODEL_LIMITS or limit != MODEL_LIMITS[model_id] or shape["batch_size"] != 1 or shape["max_options"] != 32:
            raise Rejected("unsupported")
        self.runtime = {"model": model_id, "runtimeFingerprint": fingerprint,
                        "limits": {"maxQuestions": 1, "maxChoices": 32, "maxBytes": DECISION_BYTES, "maxPromptTokens": limit}}

    def preflight(self, state, questions):
        question = strict_question(state, questions)
        tok, criteria = self.agent.tok, question["criteria"]
        if any(tok.mask_token in value for value in [state, question["instructions"], *criteria.keys(), *criteria.values()]):
            raise Rejected("reserved_token")
        encode = lambda text: tok(text, add_special_tokens=False)["input_ids"]
        expected = [tok.cls_token_id] + encode("choice question: " + question["instructions"]) + [tok.sep_token_id]
        markers = []
        for label, description in criteria.items():
            markers.append(len(expected))
            option = label if description == "" else label + ": " + description
            expected.extend([tok.mask_token_id] + encode(" " + option))
        expected.extend([tok.sep_token_id] + encode(state) + [tok.sep_token_id])
        if len(expected) > self.runtime["limits"]["maxPromptTokens"]:
            raise Rejected("too_large")
        try:
            items, _internal = self.agent.prepare(state, questions)
        except ValueError as exc:
            raise Rejected("too_large") from exc
        if len(items) != 1 or items[0]["ids"] != expected or items[0]["markers"] != markers or items[0]["qtype"] != 0:
            raise Rejected("too_large")
        try:
            arrays = self.collate(items, tok.pad_token_id, shape=self.agent.shape,
                                  pad_to_multiple=self.agent.pad_to_multiple, max_length=self.agent.cfg.get("max_len", 512))
        except (ValueError, StopIteration) as exc:
            raise Rejected("too_large") from exc
        # Also verify the actual padded representation rather than only the token count.
        ids = arrays["input_ids"][0].tolist()
        attention = arrays["attention_mask"][0].tolist()
        positions = arrays["marker_pos"][0].tolist()
        marker_mask = arrays["marker_mask"][0].tolist()
        if (len(ids) > self.agent.shape["max_length"] or ids[:len(expected)] != expected
                or any(value != tok.pad_token_id for value in ids[len(expected):])
                or attention != [1] * len(expected) + [0] * (len(ids) - len(expected))
                or positions[:len(markers)] != markers
                or marker_mask != [1] * len(markers) + [0] * (len(positions) - len(markers))):
            raise Rejected("unsupported")
        return len(expected)

    def process(self, request):
        try:
            return self._process(request)
        except Rejected as exc:
            return error_response(exc.code)
        except Exception:
            # No state, exception message or traceback in logs/wire.
            LOG.error("prediction failed")
            return error_response("unavailable")

    def _process(self, request):
        if not isinstance(request, dict):
            raise Rejected("invalid_request")
        if type(request.get("version", VERSION)) is not int or request.get("version", VERSION) != VERSION:
            raise Rejected("unsupported_version")
        op = request.get("op")
        if op == "health":
            return {"version": VERSION, "ok": True, "status": "ready", "pid": os.getpid(),
                    "model": str(self.agent.model_dir), "uptime_seconds": round(time.monotonic() - self.started, 3),
                    "operations": ["health", "predict", "preflight", "predict_strict"], "runtime": self.runtime}
        if op not in ("predict", "preflight", "predict_strict"):
            raise Rejected("invalid_operation")
        state, questions = request.get("state"), request.get("questions")
        if not isinstance(state, str):
            raise Rejected("invalid_state")
        if not isinstance(questions, dict) or not questions:
            raise Rejected("invalid_questions")
        started = time.monotonic()
        strict = op != "predict"
        if strict:
            if len(json_bytes(request)) > DECISION_BYTES:
                raise Rejected("too_large")
            if set(request) != {"version", "op", "model", "expectedRuntimeFingerprint", "budgetMs", "state", "questions"}:
                raise Rejected("invalid_request")
            if request["model"] != self.runtime["model"] or request["expectedRuntimeFingerprint"] != self.runtime["runtimeFingerprint"]:
                raise Rejected("runtime_mismatch")
            budget = request["budgetMs"]
            if type(budget) is not int or not 1 <= budget <= 600000:
                raise Rejected("invalid_request")
            deadline = started + budget / 1000
            if not self.lock.acquire(timeout=max(0, deadline - time.monotonic())):
                raise Rejected("timeout")
        else:
            deadline = math.inf
            self.lock.acquire()
        try:
            if time.monotonic() >= deadline:
                raise Rejected("timeout")
            tokens = self.preflight(state, questions) if strict else None
            if time.monotonic() >= deadline:
                raise Rejected("timeout")
            if op == "preflight":
                return {"version": VERSION, "ok": True, "runtime": self.runtime, "input_tokens": tokens}
            result = self.agent.predict(state, questions)
            # Do not release the model lock until the synchronous inference really returns.
            if time.monotonic() >= deadline:
                raise Rejected("timeout")
            if strict and result.get("usage") != {"input_tokens": tokens, "output_tokens": 0}:
                raise Rejected("unsupported")
            response = {"version": VERSION, "ok": True, "result": result,
                        "server": {"predict_ms": round((time.monotonic() - started) * 1000, 3)}}
            if strict:
                response["runtime"] = self.runtime
                if len(json_bytes(response)) > DECISION_BYTES:
                    raise Rejected("unavailable")
            return response
        finally:
            self.lock.release()


def fingerprint_files(files, context):
    """Hash the exact inference artifacts and implementation; location is not identity."""
    digest = hashlib.sha256(json_bytes(context))
    for label, path in sorted(files, key=lambda item: item[0]):
        digest.update(json_bytes(label))
        file_digest = hashlib.sha256()
        before = path.stat()
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                file_digest.update(chunk)
        after = path.stat()
        if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
            raise Rejected("runtime_mismatch")
        digest.update(file_digest.digest())
    return "sha256:" + digest.hexdigest()


def runtime_files(model_dir, laya_module):
    # Only inference inputs. Hub cache metadata, README files and compiled caches are excluded.
    files = [("worker.py", Path(__file__))]
    for name in ("coreml_config.json", "rl_agent_config.json", "model.mlpackage", "tokenizer", "encoder", "host_weights.safetensors"):
        path = model_dir / name
        if not path.exists():
            if name == "host_weights.safetensors":
                continue
            raise Rejected("unsupported")
        if path.is_dir():
            files.extend(("model/" + child.relative_to(model_dir).as_posix(), child) for child in path.rglob("*") if child.is_file())
        else:
            files.append(("model/" + name, path))
    package = Path(laya_module.__file__).parent
    files.extend(("runtime/" + path.name, path) for path in package.glob("*.py"))
    return files


def load_runtime(model_dir, model_id):
    import laya_coreml as laya
    from laya_coreml.inputs import collate_items
    manifest = json.loads((model_dir / "coreml_config.json").read_text())
    if not model_id:
        model_id = "aac6fef/laya-multilingual-coreml-ane" if manifest.get("format") == "laya-coreml-ane" else "aac6fef/laya-multilingual-coreml"
    if model_id not in MODEL_LIMITS:
        raise Rejected("unsupported")
    files = runtime_files(model_dir, laya)
    context = {"model": model_id, "strictProtocol": 1, "python": platform.python_version(), "os": platform.platform(),
               "computeUnits": "cpu_ne" if model_id.endswith("-ane") else "cpu_gpu",
               "packages": {name: importlib.metadata.version(name) for name in ("laya-coreml", "numpy", "coremltools", "tokenizers", "safetensors")}}
    fingerprint = fingerprint_files(files, context)
    agent = laya.load(str(model_dir), local_files_only=True, compute_units=context["computeUnits"])
    runtime = StrictRuntime(agent, model_id, fingerprint, collate_items)
    # Warm up once before accepting connections; hash again to detect files changed during loading.
    agent.predict("This is a warmup request.", {"warmup": {"type": "noul", "instructions": "Is this a warmup request?"}})
    if fingerprint_files(files, context) != fingerprint:
        raise Rejected("runtime_mismatch")
    return runtime


def prepare_socket(path):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists() or path.is_symlink():
        before = path.lstat()
        if not stat.S_ISSOCK(before.st_mode):
            raise RuntimeError("Refusing to replace a non-socket")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
            probe.settimeout(1)
            try:
                probe.connect(str(path))
            except ConnectionRefusedError:
                current = path.lstat()
                if (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino):
                    raise RuntimeError("Socket changed")
                path.unlink()
            else:
                raise RuntimeError("Worker already running; stop it explicitly before replacement")
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        server.bind(str(path))
        os.chmod(path, 0o600)
        server.listen(32)
        server.settimeout(1)
        return server
    except BaseException:
        server.close()
        raise


def handle_connection(conn, runtime, stop, slots):
    try:
        conn.settimeout(10)
        while not stop.is_set():
            try:
                request = recv_frame(conn)
            except EOFError:
                return
            except Rejected as exc:
                send_frame(conn, error_response(exc.code))
                return
            send_frame(conn, runtime.process(request))
    except (OSError, Rejected):
        pass
    finally:
        conn.close()
        slots.release()


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    model_dir = Path(os.environ.get("LAYA_MODEL", "~/.local/share/laya-coreml/multilingual")).expanduser().resolve()
    path = Path(os.environ.get("LAYA_SOCKET", SOCKET_DEFAULT)).expanduser().absolute()
    runtime = load_runtime(model_dir, os.environ.get("LAYA_MODEL_ID"))
    # Admit only immediately serviced connections: an executor queue would start
    # a request's budget after queueing, allowing expired client work to infer.
    stop, slots = threading.Event(), threading.BoundedSemaphore(MAX_CLIENTS)
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda _sig, _frame: stop.set())
    server = prepare_socket(path)
    identity = path.stat()
    LOG.info("READY fingerprint=%s", runtime.runtime["runtimeFingerprint"])
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_CLIENTS, thread_name_prefix="laya-client") as executor:
            while not stop.is_set():
                try:
                    conn, _ = server.accept()
                except socket.timeout:
                    continue
                if not slots.acquire(blocking=False):
                    try:
                        conn.settimeout(1)
                        send_frame(conn, error_response("busy"))
                    except OSError:
                        pass
                    finally:
                        conn.close()
                    continue
                executor.submit(handle_connection, conn, runtime, stop, slots)
    finally:
        server.close()
        try:
            current = path.lstat()
            if stat.S_ISSOCK(current.st_mode) and (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino):
                path.unlink()
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    main()
