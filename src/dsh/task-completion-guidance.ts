import {KiokukoError} from '../errors.js'
export function assertionForCriterion(evidence:string):'selected_tests_pass'|'output_matches'|'artifact_matches' {
  return evidence==='artifact'?'artifact_matches':evidence==='output'?'output_matches':'selected_tests_pass'
}
export const COMPLETION_BINDING_GUIDE={
  native_command:{requiredFields:['kind','command','cwd','sourcePaths','assertion'],
    sourcePaths:'At least one repository-relative current implementation/test path; include an asserted artifact. No absolute path or parent traversal.',
    conditions:{selected_tests_pass:'Observe complete passing selected-test output from the exact bound command; binding or exit 0 alone is not proof.',
      output_matches:'Requires expectedOutput and exact observed output.',artifact_matches:'Requires artifactPath, artifactSha256 and artifactPath in sourcePaths.',
      exit_zero:'Only when the current non-coding criterion permits it; never sufficient for a coding criterion.'}},
  enno_verifier:{requiredFields:['kind','verifierId','assertion'],condition:'Use a verifier in the current approved Enno contract; add workUnitId only for its focused verifier. No native command substitute.'},
} as const
const corrections:Record<string,string>={
  action:'Use status to read current criteria, or bind to propose a check.',
  criterionId:'Copy the exact current criterionId from task_completion status.',
  'method.kind':'Choose native_command for native work or enno_verifier for the current approved Enno route.',
  'method.command':'Supply the exact authorized foreground command matching the intended check procedure; bind does not execute it.',
  'method.cwd':'Supply an existing working directory inside the current repository; use . for its root.',
  'method.sourcePaths':COMPLETION_BINDING_GUIDE.native_command.sourcePaths,
  'method.assertion':'Match this criterion’s required evidence: selected_tests→selected_tests_pass, output→output_matches, artifact→artifact_matches. Do not weaken the criterion.',
  'method.expectedOutput':'Supply the exact expected output for output_matches.',
  'method.artifactPath':'Supply the current repository-relative artifact path and include it in sourcePaths.',
  'method.artifactSha256':'Supply the expected artifact SHA-256 as 64 lowercase hexadecimal characters.',
  'method.verifierId':'Use the exact verifierId from the current approved Enno contract, not an arbitrary command.',
}
export interface CompletionInputIssue {field:string;reason:string;expected?:string}
export function completionInputError(issues:readonly CompletionInputIssue[]):KiokukoError {
  const recovery={code:'TASK_COMPLETION_INPUT_INVALID',executed:false,verified:false,permissions:'unchanged_native_policy',issueCount:issues.length,omittedIssues:Math.max(0,issues.length-16),
    issues:issues.slice(0,16).map(issue=>({...issue,correction:corrections[issue.field.replace(/\.\d+$/u,'')]??'Read task_completion status and correct this field without changing task scope or native permissions.'})),
    bindingGuide:structuredClone(COMPLETION_BINDING_GUIDE),
    examples:[{condition:'For a current selected_tests criterion in native mode; replace the illustrative ID, command and paths using its actual authorized procedure.',
      arguments:{action:'bind',criterionId:'current-criterion-id',method:{kind:'native_command',command:'node --test tests/example.test.mjs',cwd:'.',sourcePaths:['src/example.mjs','tests/example.test.mjs'],assertion:'selected_tests_pass'}}},
      {condition:'For a current output criterion in native mode; use its real expected output and authorized paths.',arguments:{action:'bind',criterionId:'current-output-criterion-id',method:{kind:'native_command',command:'node src/example.mjs',cwd:'.',sourcePaths:['src/example.mjs'],assertion:'output_matches',expectedOutput:'42'}}}],
    nextAction:'correct_current_binding_input',note:'Examples are shapes, not permission or evidence. A successful bind remains unverified until the exact approved check is observed on current sources. Native and Enno methods are not interchangeable.'}
  return new KiokukoError('VALIDATION_ERROR',`Invalid task_completion input.\nRecovery: ${JSON.stringify(recovery)}`,recovery)
}
