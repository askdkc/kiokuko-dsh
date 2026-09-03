# Security and trust

Kiokuko for DSHはhost identityとmodel contentを別の面として扱います。
DSH hostがrun routingとcredentialを所有し、model-visible toolは意味上必要な
report fieldだけを公開します。fail-closed条件は[security boundary](security.md)
を参照してください。

検索memory、外部Skill description、advisory contributionはuntrusted contextです。
同梱Skill manifestは公開前に検証され、secretは永続ledgerへ書く前に拒否または
redactされます。
