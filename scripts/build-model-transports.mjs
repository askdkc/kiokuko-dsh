// Bundle the exact dsh-auth SDK graph and retain every dependency's license.
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/dsh/models/vendor/opencode-sdk.ts"],
  outfile: "dist/dsh/models/vendor/opencode-sdk.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  metafile: true,
});
const notices = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes("node_modules/")) continue;
  let dir = dirname(resolve(root, input));
  while (dir.includes("node_modules")) {
    try {
      const manifest = JSON.parse(
        await readFile(join(dir, "package.json"), "utf8"),
      );
      const license = await readFile(join(dir, "LICENSE"), "utf8");
      notices.set(
        manifest.name,
        `${manifest.name}@${manifest.version} (${manifest.license})\n${license}`,
      );
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    dir = dirname(dir);
  }
}
await writeFile(
  join(root, "dist/dsh/models/vendor/THIRD_PARTY_NOTICES.txt"),
  [...notices.values()].join("\n\n---\n\n") + "\n",
);
