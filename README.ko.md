# Kiokuko DeepSeek Harness Plugin

[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | 한국어

`kiokuko-dsh`는 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)를 위한 out-of-tree Cordis Plugin입니다.
Harness를 fork하거나 patch하지 않습니다. 이 저장소는 OpenCode Plugin이나 일반 Kiokuko MCP 설치 안내서가 아닙니다.

## 요구 사항 및 설치

Node.js 24.16.0 이상과 DeepSeek Harness `0.1.2-alpha.3` 호환 환경이 필요합니다.

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh --profile web --dump-config
```

삭제:

```bash
pnpm dsh plugin --profile web remove kiokuko-dsh
```

설치된 dsh CLI를 사용하는 경우 같은 인자에서 `pnpm`만 생략합니다. Plugin은 `kiokuko-dsh` bundle row 하나만 추가하며 다른 Plugin,
repository file, MCP 설정, `AGENTS.md`를 변경하지 않습니다.

## 강제 경계

- Akinator intake가 해결되지 않으면 모델과 Kiokuko 외부 tool을 실행하지 않습니다.
- 14개 operation 중 모델에 공개하는 model-facing operation은 7개뿐입니다.
- tool body 실행 전에 phase, run, revision, route, lease, idempotency를 검사합니다.
- SessionEvent를 순서와 idempotency를 유지해 ledger에 연결하고, 검증 실패 시 corrective step을 강제합니다.

OpenCode, Codex, Claude Code, Hermes Agent는 이 저장소의 Plugin surface 대상이 아니며 Kiokuko 본체의 MCP/client setup을 사용합니다. 자세한 내용은 [DeepSeek Harness Plugin 안내](docs/dsh-plugin.md)를 참조하십시오.

## 안전성과 제한

전체 대화를 저장하지 않으며 비밀번호, API key, token, private key처럼 보이는 내용은 거부합니다. 기억은 참고 정보이므로 현재 코드와 실행 결과를 확인하십시오.

MCP 호출 여부는 클라이언트와 모델이 결정하므로 **모든 턴에서 Kiokuko가 호출된다는 보장은 없습니다**. 자세한 신뢰 경계는 [영문 Security and trust](docs/security-and-trust.md)를 참조하십시오.

## 자세한 문서

[영문 문서 목차](docs/README.md)에서 Getting started, Concepts, Enno-Oduno, Semantic retrieval, Security and trust와 구현자용 문서로 이동할 수 있습니다.
