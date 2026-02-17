import fs from "node:fs";
import path from "node:path";

// Our package export map points subpath `types` at `dist/plugin-sdk/<entry>.d.ts`, so we
// generate stable entry d.ts files that re-export the real declarations.
const entrypoints = ["index", "account-id"] as const;
const declarationRoots = ["plugin-sdk", "src/plugin-sdk"] as const;

for (const entry of entrypoints) {
  const declarationPath = declarationRoots
    .map((root) => path.join(process.cwd(), `dist/plugin-sdk/${root}/${entry}.d.ts`))
    .find((candidate) => fs.existsSync(candidate));

  if (!declarationPath) {
    throw new Error(`Unable to find generated declaration for plugin-sdk entry "${entry}".`);
  }

  const relativeSpecifier = `./${path
    .relative(path.join(process.cwd(), "dist/plugin-sdk"), declarationPath)
    .replaceAll(path.sep, "/")
    .replace(/\.d\.ts$/, ".js")}`;
  const out = path.join(process.cwd(), `dist/plugin-sdk/${entry}.d.ts`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // NodeNext: reference the runtime specifier with `.js`; TS maps it back to `.d.ts`.
  fs.writeFileSync(out, `export * from "${relativeSpecifier}";\n`, "utf8");
}
