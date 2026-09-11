export function decodeSessionLog(buffer: Buffer, maxOutputLength?: number): Buffer
export function parseJsonl(plaintext: Buffer): { lines: string[]; records: unknown[] }
export function encodeSessionLog(plaintext: Buffer): Buffer
export function repairInformationalRecord(value: unknown): unknown
export function repairContinuationRecord(value: unknown): unknown
export function repairLegacyAbortRecord(value: unknown): unknown
