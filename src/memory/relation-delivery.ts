import { z } from 'zod';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { DEFAULT_RELATION_CHARACTERS, DEFAULT_RELATION_EDGE_CAP } from './context-budget.js';

export const RELATION_TYPES = ['supports', 'contradicts', 'derived_from', 'related_to'] as const;
export type RelationType = (typeof RELATION_TYPES)[number];
export interface RelationEndpoint { workspace: string; entryId: string }
export interface DeliveredRelation { from: RelationEndpoint; to: RelationEndpoint; type: RelationType }
export type SelectionOmission = 'body_budget' | 'item_limit' | 'final_filter';
export interface RelationDelivery {
  scope: 'provided_items';
  status: 'complete' | 'omitted_budget' | 'omitted_edge_cap' | 'omitted_unknown_type' | 'omitted_legacy';
  edges: DeliveredRelation[];
  selectionOmissions: SelectionOmission[];
}
export interface RelationDeliveryOptions { relationCharacterBudget?: number; relationEdgeCap?: number; selectionOmissions?: readonly SelectionOmission[] }
export interface ProvidedRelationItem { entryId: string; workspace?: string; revision?: number }
interface StoredRelation extends SqliteRow {
  kind: string; from_id: string; from_workspace: string; to_id: string; to_workspace: string; relation: string;
}

/** Compact JSON envelope, including its outer relationDelivery property. */
export function relationDeliveryCharacterCount(value: RelationDelivery): number {
  return Array.from(JSON.stringify({ relationDelivery: value })).length;
}

function limits(options: RelationDeliveryOptions) {
  const characters = options.relationCharacterBudget ?? DEFAULT_RELATION_CHARACTERS;
  const edgeCap = options.relationEdgeCap ?? DEFAULT_RELATION_EDGE_CAP;
  if (!Number.isSafeInteger(characters) || characters < 1 || characters > 100_000
    || !Number.isSafeInteger(edgeCap) || edgeCap < 1 || edgeCap > 1024
    || options.selectionOmissions?.some(reason => !['body_budget', 'item_limit', 'final_filter'].includes(reason))) {
    throw new KiokukoError('VALIDATION_ERROR', 'Relation delivery limits are invalid');
  }
  return { characters, edgeCap };
}

/** All edges or none. A complete result covers stored links between provided items only. */
export function packRelationDelivery(rows: readonly StoredRelation[], options: RelationDeliveryOptions = {}): RelationDelivery {
  const { characters, edgeCap } = limits(options);
  const fit = (status: RelationDelivery['status'], edges: DeliveredRelation[]): RelationDelivery => {
    const value: RelationDelivery = { scope: 'provided_items', status, edges,
      selectionOmissions: [...new Set(options.selectionOmissions ?? [])].sort() };
    if (relationDeliveryCharacterCount(value) <= characters) return value;
    if (status === 'complete') return fit('omitted_budget', []);
    throw new KiokukoError('VALIDATION_ERROR', 'Relation metadata budget cannot fit its explicit delivery status');
  };
  if (rows.length > edgeCap) return fit('omitted_edge_cap', []);
  if (rows.some(row => !RELATION_TYPES.includes(row.relation as RelationType))) return fit('omitted_unknown_type', []);
  const edges = rows.map(row => ({ from: { workspace: row.from_workspace, entryId: row.from_id },
    to: { workspace: row.to_workspace, entryId: row.to_id }, type: row.relation as RelationType }));
  edges.sort((a, b) => {
    const left = JSON.stringify(a), right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return fit('complete', edges);
}

/** Old deliveries without a reconstructable relation snapshot must not claim completeness. */
export function legacyRelationDelivery(options: RelationDeliveryOptions = {}): RelationDelivery {
  const { characters } = limits(options);
  const value: RelationDelivery = { scope: 'provided_items', status: 'omitted_legacy', edges: [],
    selectionOmissions: [...new Set(options.selectionOmissions ?? [])].sort() };
  if (relationDeliveryCharacterCount(value) > characters) {
    throw new KiokukoError('VALIDATION_ERROR', 'Relation metadata budget cannot fit its explicit delivery status');
  }
  return value;
}

/**
 * One statement owns the SQLite read snapshot, including selected-revision checks.
 * CROSS JOIN fixes the loop order: at most n² endpoint-pair index seeks (n <= 1000),
 * rather than scanning an unbounded outgoing adjacency list. No global sort/count.
 * LIMIT cap+1 bounds materialized edges, not the claim about internal scan work.
 */
export function readRelationDelivery(database: SqliteDatabase, items: readonly ProvidedRelationItem[],
  options: RelationDeliveryOptions = {}): RelationDelivery {
  const { edgeCap } = limits(options);
  if (items.length > 1000 || new Set(items.map(item => item.entryId)).size !== items.length
    || items.some(item => typeof item.entryId !== 'string' || !item.entryId
      || item.workspace !== undefined && (typeof item.workspace !== 'string' || !item.workspace)
      || item.revision !== undefined && (!Number.isSafeInteger(item.revision) || item.revision < 1))) {
    throw new KiokukoError('VALIDATION_ERROR', 'Provided relation endpoints are invalid');
  }
  if (items.length === 0) return packRelationDelivery([], options);
  const sql = 'WITH selected(id, workspace, revision) AS (VALUES ' + items.map(() => '(?,?,?)').join(',') + '), '
    + 'current AS (SELECT s.id, e.workspace, e.current_revision FROM selected s JOIN entries e ON e.id=s.id), '
    + 'invalid AS (SELECT 1 FROM selected s LEFT JOIN current e ON e.id=s.id '
    + 'WHERE e.id IS NULL OR (s.workspace IS NOT NULL AND s.workspace<>e.workspace) '
    + 'OR (s.revision IS NOT NULL AND s.revision<>e.current_revision) LIMIT 1), '
    + 'links AS (SELECT a.id from_id, a.workspace from_workspace, b.id to_id, b.workspace to_workspace, l.relation '
    + 'FROM current a CROSS JOIN current b CROSS JOIN entry_links l '
    + 'WHERE l.from_entry_id=a.id AND l.to_entry_id=b.id LIMIT ?) '
    + "SELECT 'invalid' kind, '' from_id, '' from_workspace, '' to_id, '' to_workspace, '' relation FROM invalid "
    + "UNION ALL SELECT 'edge' kind, from_id, from_workspace, to_id, to_workspace, relation FROM links";
  const rows = database.prepare(sql).all<StoredRelation>(...items.flatMap(item => [item.entryId, item.workspace ?? null, item.revision ?? null]), edgeCap + 1);
  if (rows.some(row => row.kind === 'invalid')) throw new KiokukoError('CONFLICT', 'Provided items changed before relation delivery');
  return packRelationDelivery(rows, options);
}

interface ModelMemoryItem {
  id?: string; entryId?: string; workspace?: string; revision?: number; entryRevision?: number;
  content?: unknown;
}

/** Final presentation boundary: keep model-visible identities and recompute for these exact items. */
export function attachRelationDelivery<T extends { items: readonly ModelMemoryItem[]; truncated?: boolean }>(
  database: SqliteDatabase, value: T, options: RelationDeliveryOptions & { itemLimit?: number } = {},
): T & { relationDelivery: RelationDelivery } {
  const ids = value.items.map(item => item.entryId ?? item.id ?? '');
  if (ids.some(id => !id) || ids.length > 1000) throw new KiokukoError('VALIDATION_ERROR', 'Model memory identities are invalid');
  const identities = ids.length ? database.prepare('SELECT id, workspace, current_revision FROM entries WHERE id IN ('
    + ids.map(() => '?').join(',') + ')').all<{ id: string; workspace: string; current_revision: number }>(...ids) : [];
  const byId = new Map(identities.map(row => [row.id, row]));
  const references = value.items.map((item, index) => {
    const current = byId.get(ids[index]!);
    if (!current) throw new KiokukoError('CONFLICT', 'A provided memory disappeared before relation delivery');
    return { entryId: current.id, workspace: item.workspace ?? current.workspace,
      revision: item.revision ?? item.entryRevision ?? current.current_revision };
  });
  const omissions = new Set(options.selectionOmissions ?? []);
  if (options.itemLimit !== undefined && value.items.length >= options.itemLimit) omissions.add('item_limit');
  const partialBody = value.items.some(item => typeof item.content === 'object' && item.content !== null
    && (item.content as { truncated?: unknown }).truncated === true);
  if (partialBody) omissions.add('body_budget');
  if (value.truncated && omissions.size === 0) omissions.add('final_filter');
  const configured: RelationDeliveryOptions = {
    relationCharacterBudget: options.relationCharacterBudget ?? Number(process.env.KIOKUKO_RELATION_CHARACTER_BUDGET ?? DEFAULT_RELATION_CHARACTERS),
    relationEdgeCap: options.relationEdgeCap ?? Number(process.env.KIOKUKO_RELATION_EDGE_CAP ?? DEFAULT_RELATION_EDGE_CAP),
    selectionOmissions: [...omissions],
  };
  const relationDelivery = readRelationDelivery(database, references, configured);
  return { ...value, items: value.items.map((item, index) => ({ ...item, entryId: references[index]!.entryId, workspace: references[index]!.workspace })), relationDelivery };
}

const Endpoint = z.object({ workspace: z.string().min(1).max(256), entryId: z.string().min(1).max(256) }).strict();
export const RelationDeliverySchema = z.object({
  scope: z.literal('provided_items'),
  status: z.enum(['complete', 'omitted_budget', 'omitted_edge_cap', 'omitted_unknown_type', 'omitted_legacy']),
  edges: z.array(z.object({ from: Endpoint, to: Endpoint, type: z.enum(RELATION_TYPES) }).strict()).max(1024),
  selectionOmissions: z.array(z.enum(['body_budget', 'item_limit', 'final_filter'])).max(3),
}).strict().superRefine((value, ctx) => {
  if (value.status !== 'complete' && value.edges.length !== 0)
    ctx.addIssue({ code: 'custom', message: 'Omitted relations must not contain a partial edge set' });
  if (new Set(value.selectionOmissions).size !== value.selectionOmissions.length)
    ctx.addIssue({ code: 'custom', message: 'Selection omission reasons must be distinct' });
});

/** The budget covers compact JSON including the outer relationDelivery property. */
export function validateRelationDelivery(value: unknown, options: RelationDeliveryOptions = {}): RelationDelivery {
  const parsed = RelationDeliverySchema.safeParse(value);
  const { characters, edgeCap } = limits(options);
  if (!parsed.success || parsed.data.edges.length > edgeCap || relationDeliveryCharacterCount(parsed.data) > characters)
    throw new KiokukoError('VALIDATION_ERROR', 'Relation delivery envelope is invalid or exceeds its limits');
  return parsed.data;
}

/** A final filter can restrict complete snapshots; an omitted snapshot is never upgraded without a new read. */
export function filterRelationDelivery(value: RelationDelivery | undefined, items: readonly RelationEndpoint[],
  options: RelationDeliveryOptions & { finalFilter?: boolean } = {}): RelationDelivery {
  if (value === undefined) return legacyRelationDelivery({ ...options,
    selectionOmissions: [...(options.selectionOmissions ?? []), ...(options.finalFilter ? ['final_filter' as const] : [])] });
  const parsed = RelationDeliverySchema.parse(value);
  const ids = new Set(items.map(item => JSON.stringify([item.workspace, item.entryId])));
  const edges = parsed.edges.filter(edge => ids.has(JSON.stringify([edge.from.workspace, edge.from.entryId]))
    && ids.has(JSON.stringify([edge.to.workspace, edge.to.entryId])));
  const selectionOmissions = [...new Set([...parsed.selectionOmissions, ...(options.selectionOmissions ?? []),
    ...(options.finalFilter || edges.length !== parsed.edges.length ? ['final_filter' as const] : [])])].sort();
  if (parsed.status !== 'complete') return validateRelationDelivery({ ...parsed, selectionOmissions }, options);
  return packRelationDelivery(edges.map(edge => ({ kind: 'edge', from_id: edge.from.entryId, from_workspace: edge.from.workspace,
    to_id: edge.to.entryId, to_workspace: edge.to.workspace, relation: edge.type })), { ...options, selectionOmissions });
}

export function configuredRelationDeliveryOptions(options: RelationDeliveryOptions = {}): Required<Pick<RelationDeliveryOptions, 'relationCharacterBudget' | 'relationEdgeCap'>> {
  const configured = { relationCharacterBudget: options.relationCharacterBudget ?? Number(process.env.KIOKUKO_RELATION_CHARACTER_BUDGET ?? DEFAULT_RELATION_CHARACTERS),
    relationEdgeCap: options.relationEdgeCap ?? Number(process.env.KIOKUKO_RELATION_EDGE_CAP ?? DEFAULT_RELATION_EDGE_CAP) };
  limits(configured);
  return configured;
}
