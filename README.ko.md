# Kiokuko DeepSeek Harness Plugin

[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | 한국어

`kiokuko-dsh`은 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)를 위한 out-of-tree Plugin입니다. 공개된 release가 있으면 [npm 패키지](https://www.npmjs.com/package/kiokuko-dsh)를 사용하고, 소스를 고정하는 Git 설치는 Plugin 안내를 사용하십시오.

## 설치

DeepSeek Harness `0.1.2-alpha.3` 및 Node.js 24.16.0 이상이 필요합니다.

공개된 npm 패키지를 설치합니다:

DeepSeek Harness checkout에서 설치:

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh --profile web --dump-config
```

GitHub를 직접 지정하려면 DeepSeek Harness checkout에서 실행하십시오:

```bash
pnpm dsh plugin --profile web add github:askdkc/kiokuko-dsh
pnpm dsh --profile web --dump-config
```

commit을 고정하는 Git 설치는 [Plugin 안내](docs/dsh-plugin.md)의 fallback을 사용하십시오.

로컬 checkout을 사용할 때는 먼저 빌드한 뒤 경로를 지정합니다:

```bash
# 다음 두 명령은 Kiokuko checkout에서 실행합니다.
pnpm install --frozen-lockfile
pnpm run build
```

그 다음 DeepSeek Harness checkout에서 빌드된 경로를 설치합니다:

```bash
dsh plugin --profile web add /absolute/path/to/kiokuko-dsh
```

설치된 `dsh` CLI를 사용할 때는 앞의 `pnpm`만 생략합니다. 삭제:

```bash
dsh plugin --profile web remove kiokuko-dsh
```

## 사용법

`/kiokuko-soul`을 실행할 필요가 없습니다. 플러그인이 내장된 `kiokuko-soul`
정책을 DSH system prompt에 자동으로 주입합니다. 설치 후 `web` 프로필을
시작하고 바로 작업을 입력하면 됩니다:

```bash
dsh web
```

자세한 내용은 [DeepSeek Harness Plugin 안내](docs/dsh-plugin.md)를 참조하십시오.

## License

MIT
