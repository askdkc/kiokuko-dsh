# Kiokuko(記憶庫) DeepSeek Harness Plugin

메모리 본문의 기본 한도는 Unicode 16,000자이며 관계 메타데이터에는 별도 한도가 적용됩니다. [메모리 전달 예산](docs/memory-delivery.md)을 참고하세요.

[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | 한국어

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)에 프로젝트 기억, 작업 계획, 검증 지원을 추가합니다.
AgenticReplay로 모델과 도구의 동작을 기록하고, 기록을 확인하거나 HTML로 내보낼 수 있습니다.

기록 본문은 기본값 `capture.content: redacted`를 유지합니다. 본문 저장을 최소화하려면 `agenticReplay.capture.content: metadata`를 선택합니다. raw 모드는 없습니다. 알려진 자격 증명 대입, 따옴표 안의 값, 인증 header 및 URL 자격 증명을 제거하고 일반 본문은 유지합니다. 모든 비밀을 감지하는 것은 아니며 과거 trace와 export를 변경하지 않습니다. 기존 파일 처리는 사용자가 별도로 선택하는 작업입니다.
DSH 표준 agent preset은 `subagent`와 `subagent_fork`를 제공합니다. 일반 하위 agent에서는 Kiokuko 실행 방식을 다시 묻지 않습니다. [설정](docs/dsh-plugin.md#subagents).


새 변경 작업에서는 일반 실행 또는 役小角(enno-oduno)를 선택할 수 있습니다. 역할별 모델은 추천 템플릿이나 DSH에 설정된 모델에서 선택합니다. [모델 선택과 연결 제한](docs/model-selection.md).

선택 기능인 [자동 모델 선택](docs/model-selection.md#automatic-model-selection)은 기본적으로 꺼져 있습니다(`modelAutoMode.mode: off`). `/kioku-model-auto on | observe | off | status`는 현재 세션만 바꿉니다. `observe`는 제안만 기록하고 실제 모델은 유지합니다. 일반 작업에서 준비된 Jev 또는 Laya, dsh-codex, DSH 모델 메타데이터와 token meter가 필요합니다. 판정에 실패하면 현재 모델을 유지하고 수동 선택을 우선합니다.

메모리는 선택 기능입니다. 작업이 끝나면 Kiokuko가 기록된 경험을 정리할지 묻고 임시 미리보기를 보여 주며, 사용자가 승인한 정확한 수정본만 저장합니다. 자동 메모리 쓰기는 더 이상 사용하지 않습니다. [검토, 회상 및 잊기](docs/replay-memory-review.md).

`/kioku-memory explain ENTRY_ID`로 출처와 정정 사항을 확인하고, `/kioku-memory forget ENTRY_ID --revision N`으로 특정 메모리를 명시적으로 잊을 수 있습니다. [증거, 설명 및 잊기](docs/memory-evidence.md).

ObservationPack은 기본값 `observationPack: { mode: auto }`를 유지합니다. 완전한 행의 발췌에 원문을 한 글자도 남길 수 없으면 pack하지 않고 전체 본문을 유지합니다. 기존 v1 pack과 handle은 계속 읽고 복원할 수 있습니다.

## 기능

- **Kiokuko Models** — 기본 Models 설정과 별도로 Web 설정 또는 `/kiokuko model`에서 연결하고 인증합니다. Infron Standard/Flex도 지원합니다. [설정 및 공유 자격 증명](docs/kiokuko-models.md)
- **실행 모드** — 일반 실행 또는 역할 기반 계획과 검증을 제공하는 役小角(enno-oduno)를 선택합니다. [자세히](docs/model-selection.md)
- **프로젝트 메모리** — 이후 작업에 유용한 프로젝트 지식을 검색합니다. [개념](docs/concepts.md)
- **심층 계획** — 네 역할이 범위를 제한한 읽기 전용 조사를 수행합니다. [사용 방법](docs/deep-planning.md)
- **DSH 하위 에이전트** — 표준 preset은 `subagent`와 `subagent_fork`를 제공하며, 기본 하위 에이전트는 Kiokuko 실행 모드를 다시 묻지 않습니다. [설정](docs/dsh-plugin.md#subagents)
- **Continuity** — 기본적으로 꺼져 있습니다. `continuity.mode: active`를 설정하면 최근 실행 증거를 모델에 요약해 전달합니다. [설정](docs/continuity.md)
- **AgenticReplay** — 모델과 도구의 활동을 기록하고 HTML로 내보냅니다. [설정 및 명령](docs/agenticreplay-recording.md)
- **일본어 출력** — 지원되는 모델에 자연스러운 일본어 출력을 위한 번들 Skill을 제공합니다. [자세히](docs/japanese-output.md)

도구 노출의 기본값은 `auto`입니다. 작업 유형과 현재 단계에 따라 모델에 표시할 Kiokuko 도구를 결정합니다. 기본 도구는 계속 사용할 수 있으며, `full`은 명시적으로 선택하는 호환성 재정의 옵션입니다. [도구 노출](docs/tool-exposure.md)을 참고하세요.

## 설치 및 사용

호환성은 공식 DSH의 현재 소스와 실제 호스트 API로 검증하며, 고정된 버전 이름을 호환 조건으로 사용하지 않습니다. [검증 범위](docs/dsh-plugin.md#compatibility)를 참고하세요.

지원 환경은 Linux x64/ARM64 및 macOS Apple Silicon이며, Intel Mac과 Windows는 지원하지 않습니다.

Node.js **24.16.0 이상**과 pnpm이 필요합니다.
DSH 소스 디렉터리에서 Web 버전을 처음 설치하고 시작합니다.

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh web
```

CLI 버전을 처음 설치하고 시작합니다.

```bash
pnpm dsh plugin --profile dsh-cli add @askdkc/dsh-cli
pnpm dsh plugin --profile dsh-cli add kiokuko-dsh
pnpm dsh --profile dsh-cli
```

전역으로 설치한 `dsh` CLI를 사용한다면 각 명령에서 `pnpm`을 생략하세요.
시작 후 평소처럼 작업을 입력하면 됩니다. Kiokuko 전용 setup 작업은 필요하지 않습니다.
GitHub 및 로컬 설치 방법은 [플러그인 안내](docs/dsh-plugin.md)를 참고하세요.

AgenticReplay 기능은 자동으로 설정되며 **수동 설정이 필요 없습니다**. 각 채팅은 확인 없이 상세 로그를 기록합니다.
기록하면 이후 모델 응답과 도구 실행 결과가 세션 작업 공간의 `.agenticreplay/runs/`에 저장됩니다. 결정은 세션별로 유지되므로 `/kioku-agenticreplay stop`한 채팅은 기록하지 않은 상태로 남습니다. 채팅 시작 시 확인하려면 `agenticReplay.askOnStart: true`를 설정하세요.

- `/kioku-agenticreplay start`: 기록을 수동으로 시작하거나 중지 후 다시 시작합니다. 해당 채팅을 중지하지 않았다면 실행할 필요가 없습니다. 과거 동작은 기록되지 않습니다.
- `/kioku-agenticreplay status`: 기록 상태, 저장 위치와 다음 동작을 간단히 표시합니다. 진단용 상세 정보는 `/kioku-agenticreplay status --json`으로 확인할 수 있습니다.

`/kioku-agenticreplay stop`으로 로그를 확정한 뒤 `list`로 run ID를 확인하고, `show <run ID>`로 내용을 보거나 `export <run ID>`로 HTML을 내보낼 수 있습니다(모두 `/kioku-agenticreplay` 뒤에 입력).
기록을 끄려면 `agenticReplay.enabled: false`를 설정하고 다시 로드하세요. 자세한 내용은 [기록 설정과 명령](docs/agenticreplay-recording.md)을 참고하세요.

## 업데이트

DSH를 종료한 뒤 Web 버전을 업데이트하고 다시 시작합니다.

```bash
pnpm dsh plugin --profile web update kiokuko-dsh --latest
pnpm dsh web
```

DSH를 종료한 뒤 CLI 버전을 업데이트하고 다시 시작합니다.

```bash
pnpm dsh plugin --profile dsh-cli update kiokuko-dsh --latest
pnpm dsh --profile dsh-cli
```

공개 후 24시간이 지나지 않은 버전으로 업데이트하려면 pnpm 11의 기본
[`minimumReleaseAge`](https://pnpm.io/settings/dependency-resolution#minimumreleaseage)
검사를 끄고 Kiokuko와 의존 패키지를 업데이트하세요.
두 번째 명령의 출력이 `0`인지 확인한 뒤 업데이트하세요.

```bash
pnpm config set --location=global --json minimumReleaseAge 0
pnpm config get minimumReleaseAge
pnpm dsh plugin --profile web update kiokuko-dsh --latest
```

이 설정은 전역으로 저장되며 이후 pnpm 설치와 업데이트에서도 공개 후 대기 기간 검사를
끕니다. 업데이트가 성공하면 DSH를 다시 시작하세요.

시작 시 일본어 출력 Skill을 포함한 모든 번들 Skill과 참조 파일을 `~/.agents/skills/`에 동기화합니다. 누락된 파일을 만들고 관리 대상 복사본을 업데이트하며, 비관리 파일은 덮어쓰지 않습니다. 다른 에이전트에서는 Skill 카탈로그를 다시 로드해야 합니다.

위 설명은 전체 패키지의 기본 동작입니다. [코어와 선택 모듈 빌드](docs/core-modules.md)는 선택한 리소스만 포함합니다. 코어는 Enno/Lisp 런타임 없이 대화·조사·글쓰기·프로젝트 메모리를 처리합니다.

시작 시 시작 디렉터리의 `AGENTS.md`에 있는 기존 Kiokuko 관리 블록도 갱신하며, 블록 밖의 지침은 보존합니다. 패키지 업데이트 후 DSH를 다시 시작하세요. 다른 작업 디렉터리나 오래된 복사본의 확인 및 복구는 [설정 절차](docs/dsh-plugin.md#what-setup-updates-and-when)를 참고하세요. `kiokuko use`는 DSH 설정 명령이 아닙니다.

`agenticreplay` 패키지의 범위는 `>=0.1.0 <1.0.0`입니다. 이후 패치 및 마이너 버전은
범위를 변경하지 않고 업데이트할 수 있습니다. 명시적으로 업데이트할 때까지 잠금 파일은 검증된 버전을 유지합니다.
업데이트 후 DSH를 다시 시작하세요. OrcaReplay에서 업데이트할 때는 명시적인 `orca` 설정을
`agenticReplay`로 변경하세요. 저장된 기록 선택과 기존 로그는 유지되지만 이전 로그는 가져오지 않습니다.
[업데이트 안내](docs/dsh-plugin.md#update) · [기록 기능 이전](docs/agenticreplay-recording.md#upgrade-from-orcareplay)

DSH 업데이트 후 Kiokuko를 불러오지 못하면 [시작 오류 복구 절차](docs/dsh-plugin.md#startup-failure-after-a-dsh-update)에서 해당 프로필의 업데이트 및 재설치 명령을 확인하세요. 세션 로그와 Kiokuko 데이터베이스는 삭제하지 마세요. API 호환성 문제는 재설치만으로 해결되지 않을 수 있습니다.

[문서](docs/README.md) · [권한](PERMISSIONS.md) · [MIT 라이선스](LICENSE)

## 타입 기반 판정（Jev / Laya / Nimble）

선택 기능인 [자동 모델 선택](docs/model-selection.md#automatic-model-selection)은 새 일반 작업에 사용할 검증된 `openai-codex` 모델과 추론 강도를 선택합니다. 기본값은 `modelAutoMode.mode: off`이며, `/kioku-model-auto on | observe | off | status`는 현재 세션만 변경합니다. `observe`는 제안을 평가하지만 모델은 변경하지 않습니다. 준비된 Jev 또는 Laya 백엔드, dsh-codex, 기본 모델 메타데이터와 token meter가 필요합니다. 분류에 실패하거나 사용할 수 없으면 현재 모델을 유지하며, 수동 모델 선택을 우선합니다.

[답변 검토](docs/answer-review.md)는 전체 플러그인과 모듈형 코어에서 기본으로 활성화됩니다. 설정된 Jev, Laya 또는 Nimble provider로 이미 표시된 일반 답변을 평가하고, 같은 주 모델에 한 번 재검토를 요청할 수 있습니다. 기본 설정은 다음과 같습니다.

```yaml
answerReview:
  mode: auto
  budgetMs: 5000
```

끄려면 `answerReview.mode: off`를 설정하세요. `typedDecisions` 설정을 이어받으며, 평가 추론과 최대 한 턴의 주 모델 호출이 추가되지만 첫 답변을 지연시키지는 않습니다. 선택한 provider를 사용할 수 없으면 검토를 건너뛰고 원래 답변을 유지하며, 다른 provider로 대체하지 않습니다. Laya v1의 결과는 worker 내부의 잘림을 확인할 수 없어 검증되지 않은 제안으로 취급합니다. `/kioku-decisions status`는 진행 상황과 건너뛴 이유를 보여 줄 뿐, 정확성을 보증하지 않습니다.

기본값은 Jev입니다. 설정 파일을 수정하거나 DSH를 다시 시작하지 않고 DSH 명령 입력란에서 전환할 수 있습니다.

```text
/kioku-decisions use jev
/kioku-decisions use laya
/kioku-decisions use nimble
/kioku-decisions use default
```

Laya는 `start-laya`로 시작한 기존 worker에 직접 연결하므로 worker 교체나 fingerprint 설정이 필요하지 않습니다. Jev에는 TypeSafe 키가 필요하고, Nimble은 엔드포인트와 모델을 먼저 설정해야 합니다. 연결 검사가 성공하면 선택을 프로젝트별로 저장하고 새 요청에 적용합니다. 재시작 후에도 유지되며 진행 중인 요청의 provider 연결은 바뀌지 않습니다. `use default`는 플러그인 설정으로 되돌립니다.

DSH의 `~/.dsh/.credentials.yaml`(`DSH_HOME`을 설정했다면 `$DSH_HOME/.credentials.yaml`)에 API 키를 설정하거나 `/kioku-typesafe-key YOUR_KEY`를 사용하세요. 기존 항목은 유지하세요.

```yaml
version: 1
refs:
  TYPESAFE_API_KEY: YOUR_KEY
```

YAML 파일을 직접 만들었다면 `chmod 600 ~/.dsh/.credentials.yaml`을 실행하세요(`DSH_HOME`을 설정했다면 해당 경로 사용).

DSH 명령 UI에서 키를 확인하고 연결을 검사하세요.

```text
/kioku-typesafe-key status
/kioku-decisions probe
/kioku-decisions status
```

`probe`는 합성 API 테스트 요청을 보내지만 `status`는 보내지 않습니다. `/kioku-typesafe-key clear`는 저장된 키를 삭제합니다. `/kioku-typesafe-key YOUR_KEY`를 사용할 때 입력한 키가 화면에 표시됩니다. 자세한 내용은 [타입 기반 판정](docs/typed-decisions.md)과 [명시적 Lisp API](docs/typesafe.md)를 참고하세요.

Jev가 기본값이며 Nimble과 로컬 [Laya-CoreML](docs/laya-coreml.md)을 대안으로 선택할 수 있습니다. Laya는 기존 v1 `health`/`predict` 프로토콜로 `~/Library/Caches/laya-coreml/worker.sock`에 직접 연결합니다. `/kioku-decisions install-laya`는 실행 중인 worker를 재사용하거나 설정 안내를 표시합니다.

영어 및 다른 언어에는 `aac6fef/laya-multilingual-coreml`을 사용하세요. 1,024-token 입력 한도에는 질문, 선택지, 상태가 모두 포함되며, `-ane` 변형은 96 tokens만 허용합니다. [원본 모델 사양](https://github.com/mizorewww/laya-coreml#available-checkpoints)을 참고하세요. [초기 설정](docs/Laya-CoreML-ja.md)을 마친 뒤 아래 명령을 사용하세요. 실행 중인 Laya worker를 종료한 후 새 모델로 시작해야 합니다. `LAYA_MODEL`은 기존 worker 스크립트의 이전 기본값도 덮어씁니다.

```bash
mkdir -p ~/.local/share/laya-coreml/multilingual
hf download \
  aac6fef/laya-multilingual-coreml \
  --local-dir ~/.local/share/laya-coreml/multilingual
LAYA_MODEL="$HOME/.local/share/laya-coreml/multilingual" start-laya
```

## 의미 기반 메모리 재사용

[의미 기반 메모리 재사용](docs/memory-reuse.md)은 provider에 대한 합성 테스트 요청이 성공한 뒤 기존 검색 후보가 현재 요청에 맞는지 확인합니다. 임베딩은 선택 사항이며, `memoryReuse.mode: off`로 이 추가 선별 단계를 끌 수 있습니다.

[메모리 적용 및 검증](docs/memory-application.md)은 채택·제외 등의 처리 결과와 호스트가 관찰한 회귀 검증 증거를 기록합니다. `/kioku-memory-application status` 또는 `/kioku-memory-application status --json`으로 현재 기본 세션의 상태를 확인하세요.

### 의미 기반 압축

ObservationPack(`observationPack: { mode: auto }`)은 성공한 대형 기본 도구 결과를 모델 호출 두 번 동안 유지한 후, 발췌문과 `observation_read` 핸들로 대체합니다. [의미 기반 압축](docs/semantic-compaction.md)은 TODO 완료 경계에서 평가하고 일반, Enno, Lisp 모드에서 기본 자동 압축에 앞서 오래된 도구 결과를 선택적으로 줄입니다. 기본값은 `semanticCompaction: { mode: auto, preemptive: true, budgetMs: 5000 }`이며, 준비된 타입 기반 판정 백엔드와 지원되는 기본 서비스가 필요합니다. `/kioku-decisions status`로 활성화 상태와 최근 결과를 확인하세요. 완전한 행의 발췌에 원문이 전혀 남지 않는 결과는 pack하지 않고 전체를 유지합니다. 기존 v1 pack과 핸들은 계속 읽고 복원할 수 있습니다.

Laya 압축의 별도 기본값은 `typedDecisions.laya-coreml.compaction.mode: off`입니다. 명시적인 `shadow`는 기록을 변경하지 않고 평가하며, `auto`는 여전히 `experimental_not_qualified` 상태입니다. 이 설정은 ObservationPack과 기본 요약의 기존 동작을 유지합니다. Akinator는 검증된 debug/research/writing 범위만 사용하며, 선택적 Skill 선택은 설명이 완전한 후보를 최대 네 개 사용하고 모델이 추가로 고르는 Skill은 최대 한 개입니다. [Laya 설정 및 평가](docs/semantic-compaction.md#local-laya)를 참고하세요.

## 선택적 코드 분석

`kioku.code`는 `@askdkc/dsh-lsp-server`를 통해 Lisp에서 코드 구조와 읽기 전용 LSP 결과를 가져옵니다.
`kiokuko-dsh`와 같은 프로필에 설치하거나 업데이트하세요. CLI에서는 `web`을 `dsh-cli`로 바꾸세요.

```sh
pnpm dsh plugin --profile web add @askdkc/dsh-lsp-server@latest
pnpm dsh plugin --profile web update @askdkc/dsh-lsp-server --latest
```

[설정, 지원 언어 및 제한](docs/code-intelligence.md)을 참고하세요.


## Lisp

명확한 일반 구현 요청은 기본 on-demand native Bash 경로에서도 첫 모델 요청 전에 Lisp 사용을 제안합니다. 대화·조사·계획만 하는 요청에는 강제하지 않으며, 같은 요청의 거절 답변을 Goal 준비에서도 재사용합니다. `/kioku-lisp enable`은 현재 세션을 켭니다. ON 상태의 구현은 작은 관련 `lisp_eval` 시험(`prototype: true`)을 실행하고 성공한 저장 결과를 `lisp_inspect`로 확인한 뒤 구현 도구를 사용합니다. ON 표시만으로 검증 성공을 주장하지 않습니다. 두 번 실패하면 자동 재시도를 멈추고 원인을 고치거나 `/kioku-lisp disable`로 일반 경로를 선택합니다. 기존 권한과 Stop은 유지됩니다. `full` 도구 표시는 Lisp ON이 아니며, 새 요청은 새 시험 증거가 필요합니다. 시험 성공은 작업 완료가 아닙니다.
