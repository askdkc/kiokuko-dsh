export const openaiModels = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-luna']
export const mockModelRoutes = [{ provider: 'mock', family: 'openai', connection: 'api', protocol: 'responses' }] as const
export function modelSelectionAnswer(question: { id: string; options?: readonly { label: string }[] }): string | undefined {
  if (question.id === 'enno-execution-mode') return '役小角を使う'
  if (question.id === 'enno-model-source') return 'おすすめテンプレートから選ぶ'
  if (question.id === 'enno-template') return question.options?.find(o => o.label.startsWith('OpenAI —'))?.label
  if (question.id === 'enno-model-review') return 'この構成で開始'
  return undefined
}
