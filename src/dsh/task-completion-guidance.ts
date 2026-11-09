import {KiokukoError} from '../errors.js'
export function assertionForCriterion(evidence:string):'selected_tests_pass'|'output_matches'|'artifact_matches' {
  return evidence==='artifact'?'artifact_matches':evidence==='output'?'output_matches':'selected_tests_pass'
}
export const COMPLETION_BINDING_GUIDE={
  typed_operation:{requiredFields:['kind','definitionVersion','operation','sourcePaths','assertion'],
    identity:'The host compares the canonical typed operation and its digest. Adapter-rendered command text is display-only and is never operation identity.',
    sourcePaths:'At least one repository-relative current implementation/test path. The host binds their current digest to the execution receipt.',
    operations:{test:{requiredFields:['kind','adapter','adapterVersion','directory','files'],adapters:['node-test','vitest'],assertion:'selected_tests_pass'},
      packageScript:{requiredFields:['kind','adapter','adapterVersion','directory','script'],adapter:'npm-script',assertion:'exit_zero'}},
    evidence:'Only a saved host receipt for the current criterion revision, owner, generation, operation digest and source digest can satisfy the binding.'},
  native_command:{requiredFields:['kind','command','cwd','sourcePaths','assertion'],
    sourcePaths:'At least one repository-relative current implementation/test path; include an asserted artifact. No absolute path or parent traversal.',
    conditions:{selected_tests_pass:'Run the bound selected tests with Node TAP or Vitest TAP/JSON. The host needs a complete report with actual test cases. Binding or exit 0 alone is not proof.',
      output_matches:'Requires expectedOutput and exact observed output.',artifact_matches:'Requires artifactPath, artifactSha256 and artifactPath in sourcePaths.',
      exit_zero:'Only when the current non-coding criterion permits it; never sufficient for a coding criterion.'}},
} as const
const corrections:Record<string,string>={
  action:'Use status to read current criteria, or bind to propose a check.',
  criterionId:'Copy the exact current criterionId from task_completion status. A local coding Goal criterionId is accepted only within the current workflow; foreign or stale namespaces are never rewritten.',
  'method.kind':'Prefer typed_operation with a versioned operation spec. Use native_command only for a legacy check without a typed adapter.',
  'method.definitionVersion':'Use definitionVersion 1 for the current typed operation contract.',
  'method.operation':'Supply a typed test or package-script operation. The adapter command is derived by the host and must not be used as identity.',
  'method.operation.kind':'Use test for Node/Vitest verification or package-script for build/typecheck/package checks.',
  'method.operation.adapter':'Use node-test or vitest for test operations, and npm-script for package-script operations.',
  'method.operation.adapterVersion':'Use adapterVersion 1.',
  'method.operation.directory':'Supply a repository-relative working directory; use . for the repository root.',
  'method.operation.files':'Supply one or more repository-relative test files for a test operation.',
  'method.operation.script':'Supply an allowed build, typecheck or test package script.',
  'method.command':'Supply the authorized command for the intended check. For Lisp process calls, bind the program and literal arguments passed to Lisp. Bind does not execute it.',
  'method.cwd':'Supply an existing working directory inside the current repository; use . for its root.',
  'method.sourcePaths':COMPLETION_BINDING_GUIDE.native_command.sourcePaths,
  'method.assertion':'Match this criterion’s required evidence: selected_tests→selected_tests_pass, output→output_matches, artifact→artifact_matches. Do not weaken the criterion.',
  'method.expectedOutput':'Supply the exact expected output for output_matches.',
  'method.artifactPath':'Supply the current repository-relative artifact path and include it in sourcePaths.',
  'method.artifactSha256':'Supply the expected artifact SHA-256 as 64 lowercase hexadecimal characters.',
}
export interface CompletionInputIssue {field:string;reason:string;expected?:string}
export function completionInputError(issues:readonly CompletionInputIssue[]):KiokukoError {
  const recovery={code:'TASK_COMPLETION_INPUT_INVALID',executed:false,verified:false,permissions:'unchanged_native_policy',issueCount:issues.length,omittedIssues:Math.max(0,issues.length-16),
    issues:issues.slice(0,16).map(issue=>({...issue,correction:corrections[issue.field.replace(/\.\d+$/u,'')]??'Read task_completion status and correct this field without changing task scope or native permissions.'})),
    bindingGuide:structuredClone(COMPLETION_BINDING_GUIDE),
    examples:[{condition:'Preferred typed Node test binding; replace the illustrative ID and paths using the current criterion.',
      arguments:{action:'bind',criterionId:'current-criterion-id',method:{kind:'typed_operation',definitionVersion:1,operation:{kind:'test',adapter:'node-test',adapterVersion:1,directory:'.',timeoutMs:120000,files:['tests/example.test.mjs'],isolation:'default'},sourcePaths:['src/example.mjs','tests/example.test.mjs'],assertion:'selected_tests_pass'}}},
      {condition:'Legacy selected_tests binding when no typed adapter exists; replace the illustrative ID, command and paths using its actual authorized procedure.',
      arguments:{action:'bind',criterionId:'current-criterion-id',method:{kind:'native_command',command:'node --test --test-reporter=tap tests/example.test.mjs',cwd:'.',sourcePaths:['src/example.mjs','tests/example.test.mjs'],assertion:'selected_tests_pass'}}},
      {condition:'For a current output criterion in native mode; use its real expected output and authorized paths.',arguments:{action:'bind',criterionId:'current-output-criterion-id',method:{kind:'native_command',command:'node src/example.mjs',cwd:'.',sourcePaths:['src/example.mjs'],assertion:'output_matches',expectedOutput:'42'}}}],
    nextAction:'correct_current_binding_input',note:'Examples are shapes, not permission or evidence. A successful bind remains unverified until the exact approved check is observed on current sources.'}
  return new KiokukoError('VALIDATION_ERROR',`Invalid task_completion input.\nRecovery: ${JSON.stringify(recovery)}`,recovery)
}
