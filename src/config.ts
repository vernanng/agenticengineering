// App configuration, strictly from .env (see .env.example).
// Nothing is defaulted here: values live in the file, not the source.
import fs from "node:fs";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env (see .env.example).`);
  return value;
}

export const PORT = Number(required("PORT"));
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PORT in .env must be a port number (1-65535).");
}
export const museBin = required("museBin");
if (!fs.existsSync(museBin)) throw new Error(`museBin in .env does not exist: ${museBin}`);
export const workspaceRoot = required("workspaceRoot");
const rootStat = fs.statSync(workspaceRoot, { throwIfNoEntry: false });
if (!rootStat?.isDirectory()) throw new Error(`workspaceRoot in .env is not a folder: ${workspaceRoot}`);
