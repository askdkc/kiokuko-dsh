# Kiokuko(記憶庫) DeepSeek Harness Plugin

[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | 한국어

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)에 프로젝트 기억, 작업 계획, 검증 지원을 추가합니다.
OrcaReplay로 모델과 도구의 동작을 기록하고, 기록을 확인하거나 HTML로 내보낼 수 있습니다.


새 변경 작업에서는 일반 실행 또는 役小角(enno-oduno)를 선택할 수 있습니다. 역할별 모델은 추천 템플릿이나 DSH에 설정된 모델에서 선택합니다. [모델 선택과 연결 제한](docs/model-selection.md).

선택 기능인 [자동 모델 선택](docs/model-selection.md#automatic-model-selection)은 기본적으로 꺼져 있습니다(`modelAutoMode.mode: off`). `/kioku-model-auto on | observe | off | status`는 현재 세션만 바꿉니다. `observe`는 제안만 기록하고 실제 모델은 유지합니다. 일반 작업에서 준비된 Jev 또는 Laya, dsh-codex, DSH 모델 메타데이터와 token meter가 필요합니다. 판정에 실패하면 현재 모델을 유지하고 수동 선택을 우선합니다.

자동 메모리 검토는 기본으로 활성화되며, 사람의 입력을 처리한 여덟 턴마다 대화 모델로 유용한 프로젝트 기억 후보를 저장하거나 갱신합니다. 대화를 닫을 필요가 없습니다. `/kioku-memory-review status`로 상태를 확인하거나 `/kioku-memory-review exclude session`으로 대화 전체를 제외할 수 있습니다. [설정, 비용과 복구](docs/auto-memory-review.md).

## 설치 및 사용

**DSH 0.1.6-alpha.1**을 지원합니다 ([검증 범위](docs/dsh-plugin.md#compatibility)).

Node.js **24.16.0 이상**과 pnpm이 필요합니다.
DSH 소스 디렉터리에서 다음 명령으로 공개된 npm 패키지를 설치하고 시작합니다.

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh web
```

전역으로 설치한 `dsh` CLI를 사용한다면 각 명령에서 `pnpm`을 생략하세요.
시작 후 평소처럼 작업을 입력하면 됩니다. Kiokuko 전용 setup 작업은 필요하지 않습니다.
GitHub 및 로컬 설치 방법은 [플러그인 안내](docs/dsh-plugin.md)를 참고하세요.

OrcaReplay 기능은 자동으로 설정되며 **수동 설정이 필요 없습니다**. 각 채팅은 확인 없이 상세 로그를 기록합니다.
기록하면 이후 모델 응답과 도구 실행 결과가 세션 작업 공간의 `.orca/runs/`에 저장됩니다. 결정은 세션별로 유지되므로 `/kioku-orca stop`한 채팅은 기록하지 않은 상태로 남습니다. 채팅 시작 시 확인하려면 `orca.askOnStart: true`를 설정하세요.

- `/kioku-orca start`: 기록을 수동으로 시작하거나 중지 후 다시 시작합니다. 해당 채팅을 중지하지 않았다면 실행할 필요가 없습니다. 과거 동작은 기록되지 않습니다.
- `/kioku-orca status`: 기록 상태, 저장 위치와 다음 동작을 간단히 표시합니다. 진단용 상세 정보는 `/kioku-orca status --json`으로 확인할 수 있습니다.

`/kioku-orca stop`으로 로그를 확정한 뒤 `list`로 run ID를 확인하고, `show <run ID>`로 내용을 보거나 `export <run ID>`로 HTML을 내보낼 수 있습니다(모두 `/kioku-orca` 뒤에 입력).
기록을 끄려면 `orca.enabled: false`를 설정하고 다시 로드하세요. 자세한 내용은 [기록 설정과 명령](docs/orca-recording.md)을 참고하세요.

## 업데이트

진행 중인 작업을 마치고 DSH를 종료한 뒤 업데이트합니다. npm으로 설치한 Kiokuko 업데이트:

```bash
pnpm dsh plugin --profile web update kiokuko-dsh --latest
pnpm dsh web
```

Kiokuko는 자주 업데이트되며, pnpm 11은 기본적으로
[`minimumReleaseAge`](https://pnpm.io/settings/dependency-resolution#minimumreleaseage)를
적용해 공개 후 24시간이 지나지 않은 버전을 선택하지 않습니다. `update --latest`를 실행해도
이전 버전이 유지되면 `~/.dsh/profiles/web/pnpm-workspace.yaml`(`pnpm-lock.yaml`이 아님)의
`minimumReleaseAgeExclude`에 다음 설정을 추가한 뒤 업데이트 명령을 다시 실행하세요.

```yaml
minimumReleaseAgeExclude:
  - kiokuko-dsh
```

시작 시 일본어 출력 Skill을 포함한 번들 Skill 9개와 참조 파일을 `~/.agents/skills/`에 동기화합니다. 누락된 파일을 만들고 관리 대상 복사본을 업데이트하며, 비관리 파일은 덮어쓰지 않습니다. 다른 에이전트에서는 Skill 카탈로그를 다시 로드해야 합니다.

위 설명은 전체 패키지의 기본 동작입니다. [코어와 선택 모듈 빌드](docs/core-modules.md)는 선택한 리소스만 포함합니다. 코어는 Enno/Lisp 런타임 없이 대화·조사·글쓰기·프로젝트 메모리를 처리합니다.

시작 시 시작 디렉터리의 `AGENTS.md`에 있는 기존 Kiokuko 관리 블록도 갱신하며, 블록 밖의 지침은 보존합니다. 패키지 업데이트 후 DSH를 다시 시작하세요. 다른 작업 디렉터리나 오래된 복사본의 확인 및 복구는 [설정 절차](docs/dsh-plugin.md#what-setup-updates-and-when)를 참고하세요. `kiokuko use`는 DSH 설정 명령이 아닙니다.

Orca 0.3.0 등 새 버전이 공개된 후 Orca 관련 의존 패키지를 업데이트하려면:

```bash
pnpm dsh plugin --profile web update --depth Infinity '@orcareplay/*'
pnpm dsh plugin --profile web why @orcareplay/core
pnpm dsh web
```

설치된 Kiokuko에 `>=0.2.1` 의존 범위가 포함되어 있어야 합니다. 이 범위는 정식 0.3.0 이후 버전을
허용하지만 기존 설치를 자동으로 업데이트하지는 않습니다. 업데이트 후 기록과 HTML 내보내기를 확인하세요.
[업데이트 상세 안내](docs/dsh-plugin.md#update)

DSH 업데이트 후 Kiokuko를 불러오지 못하면 [시작 오류 복구 절차](docs/dsh-plugin.md#startup-failure-after-a-dsh-update)에서 해당 프로필의 업데이트 및 재설치 명령을 확인하세요. 세션 로그와 Kiokuko 데이터베이스는 삭제하지 마세요. API 호환성 문제는 재설치만으로 해결되지 않을 수 있습니다.

[문서](docs/README.md) · [권한](PERMISSIONS.md) · [MIT 라이선스](LICENSE)
