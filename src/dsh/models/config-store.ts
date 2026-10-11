import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { ModelsDocumentSchema, type ModelsDocument } from "./contracts.js";
export class ModelsConfigStore {
  constructor(readonly path: string) {}
  async read(): Promise<ModelsDocument> {
    try {
      return ModelsDocumentSchema.parse(
        JSON.parse(await readFile(this.path, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, revision: 0, connections: [] };
      throw new Error(
        "Kiokuko Models configuration could not be read; repair the file before saving",
      );
    }
  }
  async write(next: ModelsDocument, expected: number): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = `${this.path}.lock`,
      end = Date.now() + 5000;
    while (true) {
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (Date.now() >= end)
          throw new Error("Connection configuration is busy; retry");
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      if ((await this.read()).revision !== expected)
        throw new Error(
          "Connection configuration changed; reload before saving",
        );
      await writeFile(
        temp,
        JSON.stringify(ModelsDocumentSchema.parse(next)) + "\n",
        { mode: 0o600 },
      );
      await rename(temp, this.path);
    } finally {
      await rm(temp, { force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
}
