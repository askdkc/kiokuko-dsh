import { rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
/** Let the bundler preserve export aliases when shared modules have identical names. */
async function clientArtifact(entry, output) {
  const result = await build({ entryPoints: [resolve(root, entry)], bundle: true,
    packages: 'external', format: 'cjs', platform: 'browser', write: false })
  const body = result.outputFiles[0].text
  const artifact = `window.__ModuleLoader__.load({
  id: "kiokuko-dsh",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");
    const { jsx, jsxs, Fragment } = require("react/jsx-runtime");
    const { useState, useRef, useEffect } = require("react");
    const { Modal, Button, IconDownloadOutline16, MarkdownText } = require("@deepseek-ai/dsh-client-ui-primitives");
${body.split('\n').map(line => `    ${line}`).join('\n')}
    return module.exports;
  }
});
`
  await writeFile(resolve(root, output), artifact, 'utf8')
}
await clientArtifact('dist/client.js', 'dist/client.cjs')
await clientArtifact('dist/models-client.js', 'dist/models-client.cjs')
await Promise.all(['dist/client.js', 'dist/client.js.map'].map(file => rm(resolve(root, file), { force: true })))
