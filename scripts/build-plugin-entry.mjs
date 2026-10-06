import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
// DSH inventory reads exported locale resources without evaluating plugin code.
// Derive the displayed version from the manifest on every build.
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const localeRoot = resolve(root, 'dist/locale')
await mkdir(localeRoot, { recursive: true })
for (const [language, description] of Object.entries({
  en: `Version ${manifest.version} — ${manifest.description}`,
  ja: `バージョン ${manifest.version} — DeepSeek Harness 向け Kiokuko プラグイン`,
  'zh-CN': `版本 ${manifest.version} — DeepSeek Harness 的 Kiokuko 插件`,
  ko: `버전 ${manifest.version} — DeepSeek Harness용 Kiokuko 플러그인`,
})) {
  await writeFile(resolve(localeRoot, `${language}.json`), JSON.stringify({
    meta: { title: manifest.name, description },
  }, null, 2) + '\n')
}
// Analyze the emitted JavaScript so erased type-only re-exports never become runtime exports.
const analysis = await build({
  absWorkingDir: root,
  entryPoints: ['dist/index.js'],
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  write: false,
  metafile: true,
})
const names = Object.values(analysis.metafile.outputs).flatMap(output => output.exports).sort()
if (!names.includes('apply') || names.some(name => !/^[A-Za-z_$][\w$]*$/.test(name) || name === 'default')) {
  throw new Error('Unsupported public Kiokuko export surface')
}

// DSH discovers browser contributions only from a package-root Cordis entry.
// Keep that entry and all its named exports; load the original graph inside the diagnostic boundary.
const runtime = (await readFile(resolve(root, 'dist/index.js'), 'utf8')).replace('index.js.map', 'plugin-runtime.js.map')
await writeFile(resolve(root, 'dist/plugin-runtime.js'), runtime)
await rename(resolve(root, 'dist/index.js.map'), resolve(root, 'dist/plugin-runtime.js.map'))
const mapPath = resolve(root, 'dist/plugin-runtime.js.map')
const map = JSON.parse(await readFile(mapPath, 'utf8'))
map.file = 'plugin-runtime.js'
await writeFile(mapPath, JSON.stringify(map))
await writeFile(resolve(root, 'dist/index.js'), `// Generated from the public exports of src/index.ts.\nimport { loadDshPlugin } from './dsh/startup-recovery.js'\nconst plugin = await loadDshPlugin(() => import('./plugin-runtime.js'))\nexport const {\n  ${names.join(',\n  ')}\n} = plugin\n`)
