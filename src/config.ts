// App configuration, strictly from .env (see .env.example).
// Nothing is defaulted here: values live in the file, not the source.
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env (see .env.example).`);
  return value;
}

export const PORT = Number(required("PORT"));
if (!Number.isInteger(PORT)) throw new Error("PORT in .env must be a number.");
export const museBin = required("museBin");
export const workspaceRoot = required("workspaceRoot");
