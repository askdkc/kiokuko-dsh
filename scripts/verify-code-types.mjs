import ts from 'typescript'
import {resolve} from 'node:path'

const path=resolve(process.argv[2] ?? 'src/dsh/lisp/code-intelligence-provider.d.ts')
const program=ts.createProgram([path],{noEmit:true,skipLibCheck:false,types:[],target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext})
const diagnostics=ts.getPreEmitDiagnostics(program)
if(diagnostics.length){console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:path=>path,getCurrentDirectory:()=>process.cwd(),getNewLine:()=> '\n'}));process.exitCode=1}
else console.log('Optional V1 provider declaration passes strict consumer checking.')
