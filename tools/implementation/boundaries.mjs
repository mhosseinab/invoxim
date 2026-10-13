const allowed = {
  web: ["contracts", "core"],
  worker: ["core", "adapters", "contracts"],
  adapters: ["core", "contracts"],
  core: ["contracts"],
  contracts: [],
  testkit: ["core", "contracts"],
};
const infrastructure =
  /^(?:@cloudflare\/|@prisma\/|prisma(?:\/|$)|cloudflare:|node:|hono(?:\/|$)|drizzle|better-auth|wrangler)/;
export function validateGraph(packages) {
  const errors = [];
  const byName = new Map(packages.map((entry) => [entry.name, entry]));
  for (const entry of packages) {
    for (const target of new Set([
      ...entry.dependencies.filter((name) => name.startsWith("@invoxim/")),
      ...entry.imports.filter((name) => name.startsWith("@invoxim/")),
    ])) {
      const dependency = byName.get(target);
      if (!dependency) {
        errors.push(`${entry.name}: unknown workspace dependency ${target}`);
        continue;
      }
      if (!allowed[entry.layer]?.includes(dependency.layer))
        errors.push(`${entry.name}: forbidden dependency ${target}`);
      if (
        entry.imports.includes(target) &&
        !entry.dependencies.includes(target)
      )
        errors.push(`${entry.name}: undeclared dependency ${target}`);
    }
    if (["core", "contracts"].includes(entry.layer))
      for (const target of [...entry.dependencies, ...entry.imports])
        if (infrastructure.test(target))
          errors.push(
            `${entry.name}: forbidden infrastructure import ${target}`,
          );
  }
  const visiting = new Set(),
    visited = new Set();
  function visit(name) {
    if (visiting.has(name)) {
      errors.push(`dependency cycle at ${name}`);
      return;
    }
    if (visited.has(name)) return;
    visiting.add(name);
    for (const target of byName.get(name)?.dependencies ?? [])
      if (byName.has(target)) visit(target);
    visiting.delete(name);
    visited.add(name);
  }
  for (const entry of packages) visit(entry.name);
  return errors;
}
