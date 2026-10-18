# Memory delivery budgets and relations

The default memory body budget is **16,000 Unicode code points**, not tokens or UTF-16 code units. Existing explicit character budgets take precedence, including continued requests and Enno refresh. Selection and ranking are unchanged. The title, summary and body projection consumes the body budget; JSON identity wrappers and relation metadata are separate. Each model-visible item carries `workspace` and `entryId`.

`relationDelivery` describes stored `entry_links` among the final provided items. Its default budget is **8,000 Unicode code points of compact `JSON.stringify({relationDelivery})`**, including the outer property key and braces, and **128 edges**. Explicit `relationCharacterBudget` / `relationEdgeCap` options take precedence over `KIOKUKO_RELATION_CHARACTER_BUDGET` / `KIOKUKO_RELATION_EDGE_CAP`, then the defaults. Character limits must be integers from 1 to 100,000; edge caps from 1 to 1,024. A limit too small even for an omission frame is an explicit validation error.

```json
{"scope":"provided_items","status":"complete","edges":[{"from":{"workspace":"project:example","entryId":"a"},"to":{"workspace":"project:example","entryId":"b"},"type":"supports"}],"selectionOmissions":[]}
```

Supported directed relation types are `supports`, `contradicts`, `derived_from` and `related_to`. Delivery includes every stored link among provided items or no edges. The other statuses are `omitted_budget`, `omitted_edge_cap`, `omitted_unknown_type` and `omitted_legacy`; all have an empty `edges` array. Legacy receipts or cut Deep snapshots cannot claim complete coverage. If final request filtering removes an item, its links are removed and `final_filter` is recorded. Previously omitted relations are never upgraded without a fresh database read.

`selectionOmissions` can contain `body_budget`, `item_limit` and `final_filter`. `complete` means coverage only of stored links among the exact final supplied items. It does not establish truth or freshness and does not rule out relevant or contradictory excluded items. Relation data remains untrusted memory content. Delivery receipts persist this projection metadata; they do not add a taxonomy store or change `entry_links`.

Approved replay projections resolve their existing indexed entry IDs, apply the same body budget and supply typed relations. Unindexed historical replay is explicitly omitted as legacy. Compatibility `memory_context` responses report legacy relation coverage; historical routine and handoff payloads keep their original bounds.

Deep snapshots retain item identity, body, envelope and their explicit metadata limits. There is no silent JSON truncation; the existing total prompt capacity can still reject an oversized request explicitly. dsh-cli passes structured tool results through native messages, presenters, replay and export without applying another memory budget.

The 16,000-character default is a bounded choice informed by a small synthetic comparison: 8k answered 6/12 cases, 8k with relations 9/12, and 16k with relations and 32k both 12/12. The 16k and 32k cases used identical inputs already fitting 16k. This is not evidence of a general optimum, production model quality or an equivalent token allowance. Historical evaluation reports retain their original explicitly configured budgets.
