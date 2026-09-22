# How to create Laya CoreML Local Environment

`start-laya`で起動済みなら、DSHで `/kioku-decisions use laya` を実行するだけです。
既存のv1 workerへ直接接続します。workerの差し替えや追加スクリプトは不要です。
Jevへ戻す場合は `/kioku-decisions use jev`。切り替えにYAML編集やDSH再起動は不要です。
接続設定の詳細は[DSHからLayaを使う手順](laya-coreml.md)を参照してください。

以下はLayaをまだ導入していない場合の初期設定です。

## モデルのダウンロードとインストール
```bash
brew install python@3.13 pipx

pipx ensurepath

pipx install \
  --python /opt/homebrew/bin/python3.13 \
  laya-coreml

pipx install huggingface-hub

mkdir -p ~/.local/share/laya-coreml/ane

hf download \
  aac6fef/laya-multilingual-coreml-ane \
  --local-dir ~/.local/share/laya-coreml/ane

# 7. インストール確認
laya-coreml --help
```

## 起動スクリプト
```bash
cat > ~/.local/bin/laya-worker.py <<'PY'
import concurrent.futures
import json
import logging
import os
import signal
import socket
import stat
import struct
import threading
import time
from pathlib import Path

import laya_coreml as laya


MODEL = Path(
    os.environ.get(
        "LAYA_MODEL",
        "~/.local/share/laya-coreml/ane",
    )
).expanduser()

SOCKET_PATH = Path(
    os.environ.get(
        "LAYA_SOCKET",
        "~/Library/Caches/laya-coreml/worker.sock",
    )
).expanduser()

MAX_FRAME = 1024 * 1024       # 1 MiB
CLIENT_TIMEOUT = 10.0
MAX_WORKERS = 8
MAX_CONNECTIONS = 32

VERSION = 1


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)

log = logging.getLogger("laya-worker")

shutdown_event = threading.Event()
predict_lock = threading.Lock()
slots = threading.BoundedSemaphore(MAX_CONNECTIONS)

started_at = time.monotonic()
agent = None


class ProtocolError(Exception):
    pass


def recv_exact(conn: socket.socket, size: int) -> bytes:
    chunks = []
    remaining = size

    while remaining:
        chunk = conn.recv(remaining)

        if not chunk:
            raise EOFError

        chunks.append(chunk)
        remaining -= len(chunk)

    return b"".join(chunks)


def recv_frame(conn: socket.socket):
    header = recv_exact(conn, 4)

    length = struct.unpack("!I", header)[0]

    if length == 0:
        raise ProtocolError("empty frame")

    if length > MAX_FRAME:
        raise ProtocolError(
            f"frame too large: {length} > {MAX_FRAME}"
        )

    payload = recv_exact(conn, length)

    try:
        return json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"invalid JSON: {exc}") from exc


def send_frame(conn: socket.socket, obj):
    payload = json.dumps(
        obj,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")

    if len(payload) > MAX_FRAME:
        raise ProtocolError("response too large")

    conn.sendall(
        struct.pack("!I", len(payload)) + payload
    )


def error_response(code, message):
    return {
        "version": VERSION,
        "ok": False,
        "error": {
            "code": code,
            "message": message,
        },
    }


def process_request(request):
    if not isinstance(request, dict):
        return error_response(
            "invalid_request",
            "request must be an object",
        )

    version = request.get("version", VERSION)

    if version != VERSION:
        return error_response(
            "unsupported_version",
            f"protocol version {version} is not supported",
        )

    op = request.get("op")

    if op == "health":
        return {
            "version": VERSION,
            "ok": True,
            "status": "ready",
            "pid": os.getpid(),
            "model": str(MODEL),
            "uptime_seconds": round(
                time.monotonic() - started_at,
                3,
            ),
        }

    if op != "predict":
        return error_response(
            "invalid_operation",
            f"unknown operation: {op!r}",
        )

    state = request.get("state")
    questions = request.get("questions")

    if not isinstance(state, str):
        return error_response(
            "invalid_state",
            "state must be a string",
        )

    if not isinstance(questions, dict) or not questions:
        return error_response(
            "invalid_questions",
            "questions must be a non-empty object",
        )

    started = time.perf_counter()

    try:
        # Core ML 推論を同時実行しない。
        # 接続処理は並列でもモデルアクセスは直列化する。
        with predict_lock:
            result = agent.predict(
                state,
                questions,
            )

    except Exception as exc:
        log.exception("prediction failed")

        return error_response(
            type(exc).__name__,
            str(exc),
        )

    predict_ms = (
        time.perf_counter() - started
    ) * 1000.0

    return {
        "version": VERSION,
        "ok": True,
        "result": result,
        "server": {
            "predict_ms": round(predict_ms, 3),
        },
    }


def handle_connection(conn: socket.socket):
    try:
        conn.settimeout(CLIENT_TIMEOUT)

        # 同一接続で複数リクエスト可能。
        while not shutdown_event.is_set():
            try:
                request = recv_frame(conn)
            except EOFError:
                return
            except socket.timeout:
                return
            except ProtocolError as exc:
                try:
                    send_frame(
                        conn,
                        error_response(
                            "protocol_error",
                            str(exc),
                        ),
                    )
                except OSError:
                    pass
                return

            response = process_request(request)

            try:
                send_frame(conn, response)
            except (
                BrokenPipeError,
                ConnectionResetError,
                socket.timeout,
            ):
                return

    except Exception:
        log.exception("connection handler failed")

    finally:
        try:
            conn.close()
        finally:
            slots.release()


def prepare_socket():
    SOCKET_PATH.parent.mkdir(
        parents=True,
        exist_ok=True,
        mode=0o700,
    )

    if SOCKET_PATH.exists() or SOCKET_PATH.is_symlink():
        info = SOCKET_PATH.lstat()

        if not stat.S_ISSOCK(info.st_mode):
            raise RuntimeError(
                f"refusing to remove non-socket: {SOCKET_PATH}"
            )

        SOCKET_PATH.unlink()

    server = socket.socket(
        socket.AF_UNIX,
        socket.SOCK_STREAM,
    )

    server.bind(str(SOCKET_PATH))
    os.chmod(SOCKET_PATH, 0o600)

    server.listen(MAX_CONNECTIONS)
    server.settimeout(1.0)

    return server


def cleanup_socket():
    try:
        if SOCKET_PATH.exists():
            info = SOCKET_PATH.lstat()

            if stat.S_ISSOCK(info.st_mode):
                SOCKET_PATH.unlink()

    except OSError:
        log.exception("failed to clean socket")


def handle_signal(signum, _frame):
    log.info("received signal %s", signum)
    shutdown_event.set()


def main():
    global agent

    if not MODEL.is_dir():
        raise RuntimeError(
            f"model directory does not exist: {MODEL}"
        )

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    log.info("loading model: %s", MODEL)

    load_started = time.perf_counter()

    agent = laya.load(
        str(MODEL),
        local_files_only=True,
    )

    load_seconds = time.perf_counter() - load_started

    log.info(
        "model loaded in %.3f sec",
        load_seconds,
    )

    # Core ML / ANE warmup
    warmup_started = time.perf_counter()

    agent.predict(
        "This is a warmup request.",
        {
            "_warmup": {
                "type": "noul",
                "instructions": "Is this a warmup request?",
            }
        },
    )

    log.info(
        "warmup completed in %.3f ms",
        (time.perf_counter() - warmup_started) * 1000.0,
    )

    server = prepare_socket()

    log.info(
        "READY socket=%s pid=%d",
        SOCKET_PATH,
        os.getpid(),
    )

    try:
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=MAX_WORKERS,
            thread_name_prefix="laya-client",
        ) as executor:

            while not shutdown_event.is_set():
                try:
                    conn, _ = server.accept()

                except socket.timeout:
                    continue

                except OSError:
                    if shutdown_event.is_set():
                        break
                    raise

                if not slots.acquire(blocking=False):
                    try:
                        send_frame(
                            conn,
                            error_response(
                                "busy",
                                "too many active connections",
                            ),
                        )
                    except OSError:
                        pass
                    finally:
                        conn.close()

                    continue

                executor.submit(
                    handle_connection,
                    conn,
                )

    finally:
        server.close()
        cleanup_socket()
        log.info("worker stopped")


if __name__ == "__main__":
    main()
PY
```

```bash
cat > ~/.local/bin/laya-call <<'PY'
#!/usr/bin/env python3

import argparse
import json
import os
import socket
import struct
import sys
from pathlib import Path

VERSION = 1
MAX_FRAME = 1024 * 1024

SOCKET_PATH = Path(
    os.environ.get(
        "LAYA_SOCKET",
        "~/Library/Caches/laya-coreml/worker.sock",
    )
).expanduser()


def recv_exact(sock, size):
    chunks = []
    remaining = size

    while remaining:
        chunk = sock.recv(remaining)

        if not chunk:
            raise RuntimeError(
                "worker closed connection unexpectedly"
            )

        chunks.append(chunk)
        remaining -= len(chunk)

    return b"".join(chunks)


def send_frame(sock, obj):
    payload = json.dumps(
        obj,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")

    if len(payload) > MAX_FRAME:
        raise RuntimeError("request too large")

    sock.sendall(
        struct.pack("!I", len(payload)) + payload
    )


def recv_frame(sock):
    header = recv_exact(sock, 4)

    length = struct.unpack("!I", header)[0]

    if length > MAX_FRAME:
        raise RuntimeError(
            f"response too large: {length}"
        )

    payload = recv_exact(sock, length)

    return json.loads(payload.decode("utf-8"))


def call(request, timeout):
    sock = socket.socket(
        socket.AF_UNIX,
        socket.SOCK_STREAM,
    )

    sock.settimeout(timeout)

    try:
        sock.connect(str(SOCKET_PATH))
        send_frame(sock, request)
        return recv_frame(sock)
    finally:
        sock.close()


def parse_questions(value):
    value = value.strip()

    # Inline JSON
    if value.startswith("{"):
        return json.loads(value)

    # JSON file
    path = Path(value).expanduser()

    with path.open(
        "r",
        encoding="utf-8",
    ) as f:
        return json.load(f)


def main():
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--timeout",
        type=float,
        default=3.0,
    )

    parser.add_argument(
        "--compact",
        action="store_true",
    )

    sub = parser.add_subparsers(
        dest="command",
        required=True,
    )

    sub.add_parser("health")

    predict = sub.add_parser("predict")

    predict.add_argument(
        "--state",
        required=True,
    )

    predict.add_argument(
        "--questions",
        required=True,
    )

    args = parser.parse_args()

    if args.command == "health":
        request = {
            "version": VERSION,
            "op": "health",
        }

    else:
        try:
            questions = parse_questions(
                args.questions
            )
        except (
            json.JSONDecodeError,
            OSError,
        ) as exc:
            print(
                f"Invalid --questions: {exc}",
                file=sys.stderr,
            )
            sys.exit(4)

        request = {
            "version": VERSION,
            "op": "predict",
            "state": args.state,
            "questions": questions,
        }

    try:
        response = call(
            request,
            args.timeout,
        )

    except FileNotFoundError:
        print(
            f"Laya worker is not ready: {SOCKET_PATH}",
            file=sys.stderr,
        )
        sys.exit(2)

    except (
        ConnectionRefusedError,
        socket.timeout,
        OSError,
        RuntimeError,
    ) as exc:
        print(
            f"Laya worker error: {exc}",
            file=sys.stderr,
        )
        sys.exit(2)

    if args.compact:
        print(
            json.dumps(
                response,
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
    else:
        print(
            json.dumps(
                response,
                ensure_ascii=False,
                indent=2,
            )
        )

    if not response.get("ok", False):
        sys.exit(3)


if __name__ == "__main__":
    main()
PY

chmod +x ~/.local/bin/laya-call

python3 -m py_compile ~/.local/bin/laya-call
```

```bash
cat > ~/.local/bin/start-laya <<'SH'
#/bin/zsh
"$HOME/Library/Application Support/pipx/venvs/laya-coreml/bin/python" \
  "$HOME/.local/bin/laya-worker.py"
SH

chmod +x ~/.local/bin/start-laya  
```


## 起動
```bash
start-laya
```

## 動作確認
```bash
laya-call predict \
  --state 'この人物は毎日ハンバーガーを3個食べている。' \
  --questions '{
    "food_quantity": {
      "type": "noul",
      "instructions": "この人物は大量のハンバーガーを食べているか?"
    }
  }'
```
