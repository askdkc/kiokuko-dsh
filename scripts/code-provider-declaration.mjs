import ts from 'typescript'

/** Derive an optional-provider module declaration from the provider-owned source. */
export function providerDeclaration(source) {
  const result = ts.transpileDeclaration(source, {compilerOptions:{target:ts.ScriptTarget.ES2023}})
  if (result.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)) throw new Error('Provider declaration generation failed')
  return "// Generated from the local upstream V1 prerequisite. See patches/code-intelligence/README.md.\ndeclare module '@askdkc/dsh-lsp-server/code-intelligence-contracts' {\n"
    + result.outputText.replaceAll('export declare ', 'export ') + '\n}\n'
}
