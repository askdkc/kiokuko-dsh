import * as z from 'zod/v4';
import {
  MODEL_TOOL_CONTRACTS,
  MODEL_TOOL_OPERATION_NAMES,
  type ModelToolContract,
  type ModelToolOperationName,
} from './contracts.js';

export type { ModelToolOperationName } from './contracts.js';

export type JsonSchema = Record<string, unknown>;

function jsonSchemaValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonSchemaValue);
  if (typeof value !== 'object') throw new Error('Model tool schema is not JSON-compatible');
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonSchemaValue(child)]));
}

function fullJsonSchema(contract: ModelToolContract): JsonSchema {
  return jsonSchemaValue(z.toJSONSchema(contract.inputSchema, { unrepresentable: 'any' })) as JsonSchema;
}

function removeHostOwnedFields(schema: JsonSchema, fields: readonly string[]): JsonSchema {
  const projected = structuredClone(schema);
  const properties = projected.properties;
  if (typeof properties === 'object' && properties !== null && !Array.isArray(properties)) {
    const propertyMap = properties as Record<string, unknown>;
    for (const field of fields) delete propertyMap[field];
  }
  if (Array.isArray(projected.required)) {
    projected.required = projected.required.filter((field): field is string => (
      typeof field === 'string' && !fields.includes(field)
    ));
  }
  return projected;
}

function assertContract(contract: ModelToolContract): ModelToolContract {
  const schema = fullJsonSchema(contract);
  const properties = schema.properties;
  const propertyNames = new Set(
    typeof properties === 'object' && properties !== null && !Array.isArray(properties)
      ? Object.keys(properties)
      : [],
  );
  for (const field of contract.hostOwnedFields) {
    if (!propertyNames.has(field)) throw new Error(`${contract.name} host-owned field is absent from its schema: ${field}`);
  }
  return contract;
}

const validatedContracts = MODEL_TOOL_CONTRACTS.map(assertContract);
if (validatedContracts.length !== MODEL_TOOL_OPERATION_NAMES.length
  || new Set(validatedContracts.map((contract) => contract.name)).size !== validatedContracts.length
  || validatedContracts.some((contract, index) => contract.name !== MODEL_TOOL_OPERATION_NAMES[index])) {
  throw new Error('Model tool registry must contain the exact unique operation set');
}

export const MODEL_TOOL_REGISTRY = Object.freeze(Object.fromEntries(
  validatedContracts.map((contract) => [contract.name, Object.freeze(contract)]),
)) as Readonly<Record<ModelToolOperationName, ModelToolContract>>;

export function modelToolContract(name: ModelToolOperationName): ModelToolContract {
  return MODEL_TOOL_REGISTRY[name];
}

export function modelFacingInputSchema(name: ModelToolOperationName): JsonSchema {
  const contract = modelToolContract(name);
  return projectModelFacingInputSchema(name, fullJsonSchema(contract));
}

/** Strip host-owned fields from a current revision-bound report schema. */
export function projectModelFacingInputSchema(name: ModelToolOperationName, schema: JsonSchema): JsonSchema {
  return removeHostOwnedFields(schema, modelToolContract(name).hostOwnedFields);
}
