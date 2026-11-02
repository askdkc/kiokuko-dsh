// Native consumer fixtures use Kiokuko's actual replacement AgentFactory.
// The package override exercises the current distribution rather than source.
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
const root=process.env.KIOKUKO_SKILL_PACKAGE_ROOT
const driver=await import(root?pathToFileURL(join(root,'dist/dsh/harness/index.js')).href:new URL('../../../src/dsh/harness/index.ts',import.meta.url).href)
export default driver
