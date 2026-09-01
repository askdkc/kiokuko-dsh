# Kiokuko DeepSeek Harness Plugin

[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | 한국어

`kiokuko-dsh`는 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)를 위한 out-of-tree Plugin입니다.
아직 npm에 공개되지 않았습니다.

## 설치

DeepSeek Harness `0.1.2-alpha.3` 및 Node.js 24.16.0 이상이 필요합니다.

처음 Git으로 설치하기 전에 `web` profile에서 이 패키지의 build를 허용합니다.
실패한 설치에서 pnpm이 표시한 commit 포함 exact key를
`~/.dsh/profiles/web/pnpm-workspace.yaml`에 추가하십시오.

```yaml
allowBuilds:
  "kiokuko-dsh@https://codeload.github.com/askdkc/kiokuko-dsh/tar.gz/<commit>": true
```

기존 항목은 유지하고 `<commit>`을 pnpm이 표시한 값으로 바꾼 뒤 아래 설치 명령을 다시 실행합니다.

DeepSeek Harness checkout에서 설치:

```bash
pnpm dsh plugin --profile web add github:askdkc/kiokuko-dsh
pnpm dsh --profile web --dump-config
```

로컬 checkout을 사용할 때는 먼저 빌드한 뒤 경로를 지정합니다:

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm dsh plugin --profile web add /path/to/kiokuko-dsh
```

설치된 `dsh` CLI를 사용할 때는 앞의 `pnpm`만 생략합니다. 삭제:

```bash
dsh plugin --profile web remove kiokuko-dsh
```

npm에 공개하기 전에는 `kiokuko-dsh`만 단독으로 지정하지 마십시오. npm registry 패키지로 해석됩니다.

자세한 내용은 [DeepSeek Harness Plugin 안내](docs/dsh-plugin.md)를 참조하십시오.

## License

MIT
