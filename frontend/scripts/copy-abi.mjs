import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// frontend/scripts/copy-abi.mjs — run from frontend/ via `npm run sync-abi`.
// Pulls the compiled artifact (ABI + bytecode) from the sibling hardhat/ project so
// the frontend always calls the contract that's actually deployed, not a stale copy.
const __dirname = dirname(fileURLToPath(import.meta.url));

const src = join(
  __dirname,
  "..",
  "..",
  "hardhat",
  "artifacts",
  "contracts",
  "RitualPredict.sol",
  "RitualPredict.json",
);
const destDir = join(__dirname, "..", "src", "abi");
const dest = join(destDir, "RitualPredict.json");

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`Copied ABI:\n  from ${src}\n  to   ${dest}`);
