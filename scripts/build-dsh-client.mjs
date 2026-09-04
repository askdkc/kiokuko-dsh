import { readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const compiledOutput = resolve(root, 'dist/client.js')
const output = resolve(root, 'dist/client.cjs')
const sourceMap = resolve(root, 'dist/client.js.map')
const compiled = await readFile(compiledOutput, 'utf8')

const exportsToStrip = ['apply', 'downloadDshSessionLog', 'inject']
let body = compiled.replace(/\n?\/\/# sourceMappingURL=client\.js\.map\s*$/u, '')
for (const name of exportsToStrip) {
  const pattern = new RegExp(`^export (?=(?:async )?(?:function|const) ${name}\\b)`, 'mu')
  if (!pattern.test(body)) throw new Error(`DSH client build did not find exported ${name}`)
  body = body.replace(pattern, '')
}
if (/^\s*(?:import|export)\b/mu.test(body)) {
  throw new Error('DSH client build left ESM syntax in the lazy-CJS artifact')
}

const artifact = `window.__ModuleLoader__.load({
  id: "kiokuko-dsh",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");
    const { jsx, jsxs, Fragment } = require("react/jsx-runtime");
    const { useState, useRef, useEffect } = require("react");
    const { Modal, Button, IconDownloadOutline16 } = require("@deepseek-ai/dsh-client-ui-primitives");
${body.split('\n').map(line => `    ${line}`).join('\n')}
    exports.apply = apply;
    exports.downloadDshSessionLog = downloadDshSessionLog;
    exports.inject = inject;
    return module.exports;
  }
});
`

await writeFile(output, artifact, 'utf8')
await Promise.all([rm(compiledOutput, { force: true }), rm(sourceMap, { force: true })])
