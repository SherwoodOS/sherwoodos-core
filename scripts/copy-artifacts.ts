import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, "contracts", "out");
const dest = join(root, "backend", "src", "chain", "artifacts");
mkdirSync(dest, { recursive: true });

for (const name of ["SHOS", "SHOSStaking", "SherwoodRouter"]) {
  const artifact = JSON.parse(readFileSync(join(out, `${name}.sol`, `${name}.json`), "utf8"));
  const slim = { contractName: name, abi: artifact.abi, bytecode: artifact.bytecode.object };
  writeFileSync(join(dest, `${name}.json`), JSON.stringify(slim));
  console.log(`${name}: abi ${artifact.abi.length} entries, bytecode ${slim.bytecode.length / 2 - 1} bytes`);
}
