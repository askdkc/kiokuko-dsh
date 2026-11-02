export const openaiModels = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']
export const mockModelRoutes = [{ provider: 'mock', family: 'openai', connection: 'api', protocol: 'responses' }] as const
export function modelSelectionAnswer(question: { id: string; options?: readonly { label: string }[] }): string | undefined {
  if (question.id === 'execution-mode') return '通常実行'
  return undefined
}
