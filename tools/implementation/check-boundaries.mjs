import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { validateGraph } from "./boundaries.mjs";

const root = path.resolve(process.argv[2] ?? ".");
async function directories(folder) {
  try {
    return (await readdir(folder, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(folder, entry.name));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
const entries = [];
for (const base of ["apps", "packages"])
  for (const folder of await directories(path.join(root, base))) {
    const manifest = JSON.parse(
      await readFile(path.join(folder, "package.json"), "utf8"),
    );
    entries.push({
      name: manifest.name,
      layer: path.basename(folder),
      folder,
      dependencies: [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
      ],
      imports: [],
    });
  }
async function scan(folder, entry) {
  for (const file of await readdir(folder, { withFileTypes: true })) {
    if (
      [
        "node_modules",
        "dist",
        ".wrangler",
        ".turbo",
        "test",
        "tests",
        "__tests__",
      ].includes(file.name)
    )
      continue;
    const full = path.join(folder, file.name);
    if (file.isDirectory()) {
      await scan(full, entry);
      continue;
    }
    if (
      !/\.(?:[cm]?[jt]sx?)$/.test(file.name) ||
      /(?:\.test\.|\.spec\.|\.config\.)/.test(file.name)
    )
      continue;
    const source = ts.createSourceFile(
      full,
      await readFile(full, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    function record(value) {
      if (value.startsWith(".")) {
        const resolved = path.resolve(folder, value);
        const owner = entries.find((candidate) =>
          resolved.startsWith(candidate.folder + path.sep),
        );
        if (owner && owner.name !== entry.name) entry.imports.push(owner.name);
      } else
        entry.imports.push(
          value.startsWith("@invoxim/")
            ? value.split("/").slice(0, 2).join("/")
            : value,
        );
    }
    function walk(node) {
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        record(node.argument.literal.text);
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        ts.isStringLiteral(node.moduleReference.expression)
      )
        record(node.moduleReference.expression.text);
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        record(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument)) record(argument.text);
        else
          throw new Error(
            `${full}: nonliteral dynamic import cannot be boundary checked`,
          );
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
  }
}
for (const entry of entries) await scan(entry.folder, entry);
const errors = validateGraph(entries);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `Package boundaries valid (${entries.length} concrete packages).`,
  );
