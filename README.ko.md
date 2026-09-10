# Kiokuko(記憶庫) DeepSeek Harness Plugin

[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | 한국어

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)에 프로젝트 기억, 작업 계획, 검증 지원을 추가합니다.
OrcaReplay로 모델과 도구의 동작을 기록하고, 기록을 확인하거나 HTML로 내보낼 수 있습니다.


새 변경 작업에서는 일반 실행 또는 役小角(enno-oduno)를 선택할 수 있습니다. 역할별 모델은 추천 템플릿이나 DSH에 설정된 모델에서 선택합니다. [모델 선택과 연결 제한](docs/model-selection.md).
## 설치 및 사용

DSH `0.1.2-rc.1`, [0.1.3-alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1), [v0.1.3-alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.2), [v0.1.5-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1)를 지원합니다.
Node.js **24.16.0 이상**과 pnpm이 필요합니다.
DSH 소스 디렉터리에서 다음 명령으로 공개된 npm 패키지를 설치하고 시작합니다.

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh web
```

전역으로 설치한 `dsh` CLI를 사용한다면 각 명령에서 `pnpm`을 생략하세요.
시작 후 평소처럼 작업을 입력하면 됩니다. Kiokuko 전용 setup 작업은 필요하지 않습니다.
GitHub 및 로컬 설치 방법은 [플러그인 안내](docs/dsh-plugin.md)를 참고하세요.

OrcaReplay 기능은 자동으로 설정되며 **수동 설정이 필요 없습니다**. 채팅 시작 시 상세 로그를 기록할지 선택합니다.
기록을 선택하면 이후 모델 응답과 도구 실행 결과가 세션 작업 공간의 `.orca/runs/`에 저장됩니다. 선택은 세션별로 유지되며, 건너뛰거나 취소하면 기록 없이 채팅을 계속합니다.

- `/kioku-orca start`: 기록을 수동으로 시작하거나 중지 후 다시 시작합니다. 시작 시 기록을 선택했다면 실행할 필요가 없습니다. 과거 동작은 기록되지 않습니다.
- `/kioku-orca status`: 기록 상태, 저장 위치와 다음 동작을 간단히 표시합니다. 진단용 상세 정보는 `/kioku-orca status --json`으로 확인할 수 있습니다.

`/kioku-orca stop`으로 로그를 확정한 뒤 `list`로 run ID를 확인하고, `show <run ID>`로 내용을 보거나 `export <run ID>`로 HTML을 내보낼 수 있습니다(모두 `/kioku-orca` 뒤에 입력).
기록을 끄려면 `orca.enabled: false`를 설정하고 다시 로드하세요. 자세한 내용은 [기록 설정과 명령](docs/orca-recording.md)을 참고하세요.

## 업데이트

진행 중인 작업을 마치고 DSH를 종료한 뒤 업데이트합니다. npm으로 설치한 Kiokuko 업데이트:

```bash
pnpm dsh plugin --profile web update kiokuko-dsh --latest
```

Orca 0.3.0 등 새 버전이 공개된 후 Orca 관련 의존 패키지를 업데이트하려면:

```bash
pnpm dsh plugin --profile web update --depth Infinity '@orcareplay/*'
pnpm dsh plugin --profile web why @orcareplay/core
pnpm dsh web
```

설치된 Kiokuko에 `>=0.2.1` 의존 범위가 포함되어 있어야 합니다. 이 범위는 정식 0.3.0 이후 버전을
허용하지만 기존 설치를 자동으로 업데이트하지는 않습니다. 업데이트 후 기록과 HTML 내보내기를 확인하세요.
[업데이트 상세 안내](docs/dsh-plugin.md#update)

[문서](docs/README.md) · [권한](PERMISSIONS.md) · [MIT 라이선스](LICENSE)
