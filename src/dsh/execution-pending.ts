export class ExecutionSelectionPending extends Error {
  constructor(message = '実行方式・モデル構成の選択待ちです。依頼と完了済みの作業は保持されています。') { super(message) }
}
