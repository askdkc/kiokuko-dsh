import { KiokukoError } from '../errors.js';
import { renderMemoryFields } from './memory-projection.js';
import { findSecretInValue } from '../memory/secrets.js';
import { configuredRelationDeliveryOptions, filterRelationDelivery, type RelationDelivery } from '../memory/relation-delivery.js';

export function renderModelMemory(item: { workspace?: string; entryId: string; title: string; summary: string | null; bodyPreview: string }): string | null {
  const text = renderMemoryFields(item);
  if (text === null || !item.workspace || !item.entryId || findSecretInValue({ workspace: item.workspace, entryId: item.entryId })) return null;
  return JSON.stringify({ workspace: item.workspace, entryId: item.entryId, text });
}

export function renderModelRelations(relationDelivery: RelationDelivery): string {
  return 'Stored relation data. complete means coverage of stored links between provided items only; it does not establish freshness or truth. Selection omissions may hide other relevant or contradictory items.\n'
    + JSON.stringify(relationDelivery);
}

/** Serialize only provided bodies and their relation envelope, never ranking/debug duplicates. */
export function serializeModelMemoryContext(context: { items: readonly Parameters<typeof renderModelMemory>[0][];
  relationDelivery?: RelationDelivery; relationCharacterBudget?: number; relationEdgeCap?: number } | null): string {
  const original = context?.items ?? [];
  const items = original.flatMap(item => { const rendered = renderModelMemory(item); return rendered === null ? [] : [JSON.parse(rendered) as {workspace:string;entryId:string;text:string}]; });
  const relationDelivery = filterRelationDelivery(context?.relationDelivery, items, {
    ...(context?.relationCharacterBudget === undefined ? {} : { relationCharacterBudget: context.relationCharacterBudget }),
    ...(context?.relationEdgeCap === undefined ? {} : { relationEdgeCap: context.relationEdgeCap }),
    finalFilter: items.length !== original.length,
  });
  return JSON.stringify({ items, relationDelivery, ...configuredRelationDeliveryOptions(context ?? {}) });
}

/** Historical Deep contexts may lack identities/relations or have been cut mid-JSON. */
export function normalizeStoredModelContext(value: string): string {
  if (findSecretInValue(value)) throw new KiokukoError('SECURITY_REJECTION', 'Secret-shaped memory is not forwarded to Deep workers');
  let parsed: { items?: unknown; relationDelivery?: RelationDelivery; relationCharacterBudget?: number; relationEdgeCap?: number };
  try { parsed = JSON.parse(value); } catch { parsed = {}; }
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items) && parsed.relationDelivery !== undefined
    && parsed.items.every(item => item && typeof item.workspace === 'string' && typeof item.entryId === 'string' && typeof item.text === 'string')) {
    const relationDelivery = filterRelationDelivery(parsed.relationDelivery, parsed.items, configuredRelationDeliveryOptions(parsed));
    return JSON.stringify({ items: parsed.items, relationDelivery, ...configuredRelationDeliveryOptions(parsed) });
  }
  return serializeModelMemoryContext(null);
}
