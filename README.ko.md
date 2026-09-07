# Kiokuko(記憶庫) DeepSeek Harness Plugin

[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | 한국어

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)에 프로젝트 기억, 작업 계획, 검증 지원을 추가합니다.
선택 기능인 OrcaReplay 기록을 켜면 모델과 도구의 동작을 확인하고 HTML로 내보낼 수 있습니다.

## 설치 및 사용

DSH `0.1.2-rc.1`과 [0.1.3-alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1)을 지원합니다.
Node.js **24.16.0 이상**과 pnpm이 필요합니다.
설치된 `dsh` CLI로 공개된 npm 패키지를 설치하고 시작합니다.

```bash
dsh plugin --profile web add kiokuko-dsh
dsh web
```

DSH 소스 디렉터리에서 실행한다면 각 `dsh` 명령 앞에 `pnpm`을 붙입니다.
시작 후 평소처럼 작업을 입력하면 됩니다. Kiokuko 전용 setup 작업은 필요하지 않습니다.
GitHub 및 로컬 설치 방법은 [플러그인 안내](docs/dsh-plugin.md)를 참고하세요.

Orca 의존 패키지는 자동 설치되며 기록은 **기본적으로 꺼져 있습니다**.
플러그인 설정의 `orca.enabled`를 `true`로 바꾸고 다시 로드하면 활성화됩니다.
`/kioku-orca list`, `/kioku-orca show <run ID>`, `/kioku-orca export <run ID>`로 기록을 확인하고 내보낼 수 있습니다.
자세한 내용은 [기록 설정과 명령](docs/orca-recording.md)을 참고하세요.

## 업데이트

진행 중인 작업을 마치고 DSH를 종료한 뒤 업데이트합니다. npm으로 설치한 Kiokuko 업데이트:

```bash
dsh plugin --profile web update kiokuko-dsh --latest
```

Orca 0.3.0 등 새 버전이 공개된 후 Orca 관련 의존 패키지를 업데이트하려면:

```bash
dsh plugin --profile web update --depth Infinity '@orcareplay/*'
dsh plugin --profile web why @orcareplay/core
dsh web
```

설치된 Kiokuko에 `>=0.2.1` 의존 범위가 포함되어 있어야 합니다. 이 범위는 정식 0.3.0 이후 버전을
허용하지만 기존 설치를 자동으로 업데이트하지는 않습니다. 업데이트 후 기록과 HTML 내보내기를 확인하세요.
[업데이트 상세 안내](docs/dsh-plugin.md#update)

[문서](docs/README.md) · [권한](PERMISSIONS.md) · [MIT 라이선스](LICENSE)
