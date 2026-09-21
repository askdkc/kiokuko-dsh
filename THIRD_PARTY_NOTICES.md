# Third-party notices

The private legacy-history codec bundle includes code from the following MIT-licensed DeepSeek packages. These packages are not installed as runtime dependencies.

- `@deepseek-ai/dsh-util-values@0.1.5-rc.2`
- `@deepseek-ai/dsh-session-format@0.1.5-rc.1`
- `@deepseek-ai/dsh-session-format-v0-to-v1@0.1.5-rc.1`
- `@deepseek-ai/dsh-session-format-v1-to-v2@0.1.5-rc.1`
- `@deepseek-ai/dsh-llm@0.1.5-rc.2`

MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
# Bundled Common Lisp libraries

The `lisp/vendor/` directory contains the pinned upstream source trees listed
below. Each directory retains its original copyright and license notices and an
`UPSTREAM.json` commit record. `lisp/vendor-manifest.json` records every bundled
file's SHA-256; verify with `npm run verify:lisp:vendor`.

| Library | Upstream | License |
|---|---|---|
| YASON | phmarek/yason | BSD (see LICENSE) |
| CL-PPCRE | edicl/cl-ppcre | BSD-2-Clause |
| CL-CSV | AccelerationNet/cl-csv | BSD (see LICENSE) |
| Alexandria | common-lisp.net/alexandria | Public domain / permissive fallback (source notices) |
| trivial-gray-streams | trivial-gray-streams/trivial-gray-streams | MIT (COPYING) |
| Iterate | common-lisp.net/iterate | MIT (source and README notices) |
| CL-INTERPOL | edicl/cl-interpol | BSD-2-Clause (source notices) |
| CL-UNICODE | edicl/cl-unicode | BSD-2-Clause; Unicode data retains its own notices |
| FLEXI-STREAMS | edicl/flexi-streams | BSD-2-Clause (source notices) |
| named-readtables | melisgl/named-readtables | BSD (LICENSE) |
| MGL-PAX bootstrap | melisgl/mgl-pax | MIT (COPYING) |

CL-UNICODE's generated tables are produced from its bundled Unicode data by its
upstream `cl-unicode/build` system and shipped as source, so plugin users do not
need to regenerate them. No SBCL binary, Python runtime, Bubblewrap, VM runtime,
or Homebrew bottle is included in the plugin package.

# Optional Laya-CoreML worker

`scripts/laya-worker.py` implements a strict input checker for Laya-CoreML's
Apache-2.0 prompt layout. Changes: independent untruncated input construction,
prepare/collate comparison, bounded Unix framing, runtime fingerprinting and
strict operations. The inference runtime and model weights are installed
separately; neither is bundled. [Apache-2.0 license](docs/laya-coreml-LICENSE.txt).

- Laya-CoreML: https://github.com/mizorewww/laya-coreml
  Copyright 2026 laya-coreml contributors.
  Referenced revision: `12b7501583c7f03a6b2e49ebe118a2c6302505b9`.
- Laya: https://github.com/NandhaKishorM/laya
  Copyright Convai Innovations and Laya contributors.
  Upstream revision: `6a5819129eb220570792e417e49723d697efd76f`.
- Laya-MLX: https://github.com/mizorewww/laya-mlx
  Copyright 2026 laya-mlx contributors. Apache-2.0.
  Adapted revision: `fc1df62828a3fedf4d8229fdac1cbd85f1cdf337`.

The model's original checkpoint weights retain their upstream authors' notices.
This is an independent integration, not an official Convai Innovations or Apple release.
