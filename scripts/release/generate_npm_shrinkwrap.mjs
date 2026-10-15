/**
 * Generate an `npm-shrinkwrap.json` for the CLI package (`@chainsafe/lodestar`) from `pnpm-lock.yaml`.
 *
 * Why: `npm install @chainsafe/lodestar` ignores `pnpm-lock.yaml`, so every dependency is re-resolved to the
 * newest semver-compatible version at install time, which exposes users to dependency (supply chain) attacks.
 * npm honors `npm-shrinkwrap.json` of a published package, so shipping one pins the full production dependency
 * tree to the exact versions and integrity hashes that were tested in CI.
 * See https://github.com/ChainSafe/lodestar/issues/3596
 *
 * `npm shrinkwrap` can't be used since it does not support workspaces, and it would re-resolve versions anyway.
 *
 * Usage: node scripts/release/generate_npm_shrinkwrap.mjs [outputPath]
 * Default output is `packages/cli/npm-shrinkwrap.json`, which is picked up by `lerna publish`.
 *
 * Only the production dependency closure of the CLI is included. First-party `@lodestar/*` workspace packages are
 * emitted as regular registry entries (without integrity) since they are published in the same release.
 */
import fs from "node:fs";
import {createRequire} from "node:module";
import path from "node:path";
import {fileURLToPath} from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliDir = "packages/cli";
const registry = "https://registry.npmjs.org";

// js-yaml is a dependency of the CLI package, resolve it from there as pnpm does not hoist to the root
const yaml = createRequire(path.join(rootDir, cliDir, "package.json"))("js-yaml");

const outputPath = process.argv[2] ?? path.join(rootDir, cliDir, "npm-shrinkwrap.json");

const lock = yaml.load(fs.readFileSync(path.join(rootDir, "pnpm-lock.yaml"), "utf8"));
if (!String(lock.lockfileVersion).startsWith("9.")) {
  throw Error(`Unsupported pnpm-lock.yaml lockfileVersion ${lock.lockfileVersion}, expected 9.x`);
}

const readPkg = (dir) => JSON.parse(fs.readFileSync(path.join(rootDir, dir, "package.json"), "utf8"));

/** Convert a pnpm reference (`1.2.3(peer@1.0.0)`, `link:../api`, `foo@1.2.3`) of dependency `alias` to a node */
function resolveRef(alias, ref, importerDir) {
  if (ref.startsWith("link:")) {
    return {kind: "workspace", alias, dir: path.posix.normalize(path.posix.join(importerDir, ref.slice(5)))};
  }
  // npm aliases are stored as `<realName>@<version>`
  const key = ref.startsWith("npm:") ? ref.slice(4) : /^\d/.test(ref) ? `${alias}@${ref}` : ref;
  return {kind: "registry", alias, key};
}

function registryNode(alias, key) {
  const snapshot = lock.snapshots[key];
  if (snapshot === undefined) throw Error(`Missing snapshot ${key}`);
  // Strip peer dependency suffix `(...)`, snapshot keys may contain scopes so only look for "@" after the name
  const baseKey = key.replace(/\(.*$/, "");
  const at = baseKey.indexOf("@", 1);
  const name = baseKey.slice(0, at);
  const version = baseKey.slice(at + 1);
  const meta = lock.packages[baseKey];
  if (meta === undefined) throw Error(`Missing package ${baseKey}`);
  const {integrity, tarball} = meta.resolution ?? {};
  if (integrity === undefined || (tarball !== undefined && !tarball.startsWith(registry))) {
    throw Error(`Package ${baseKey} is not a registry package with integrity, unsupported: ${JSON.stringify(meta.resolution)}`);
  }
  const entry = {
    version,
    resolved: `${registry}/${name}/-/${name.split("/").pop()}-${version}.tgz`,
    integrity,
  };
  if (alias !== name) entry.name = name;
  if (meta.os) entry.os = meta.os;
  if (meta.cpu) entry.cpu = meta.cpu;
  if (meta.libc) entry.libc = meta.libc;
  if (meta.engines) entry.engines = meta.engines;
  const deps = Object.entries(snapshot.dependencies ?? {}).map(([a, r]) => resolveRef(a, r, ""));
  const optDeps = Object.entries(snapshot.optionalDependencies ?? {}).map(([a, r]) => resolveRef(a, r, ""));
  return {id: key, name: alias, entry, deps, optDeps, optional: snapshot.optional === true};
}

function workspaceNode(alias, dir) {
  const pkg = readPkg(dir);
  const importer = lock.importers[dir];
  if (importer === undefined) throw Error(`Missing importer ${dir}`);
  const toRefs = (obj) => Object.entries(obj ?? {}).map(([a, spec]) => resolveRef(a, spec.version, dir));
  const entry = {
    version: pkg.version,
    resolved: `${registry}/${pkg.name}/-/${pkg.name.split("/").pop()}-${pkg.version}.tgz`,
  };
  if (pkg.engines) entry.engines = pkg.engines;
  return {
    id: `workspace:${dir}`,
    name: alias,
    entry,
    deps: toRefs(importer.dependencies),
    optDeps: toRefs(importer.optionalDependencies),
    optional: false,
  };
}

const nodeCache = new Map();
function getNode(ref, alias) {
  const id = ref.kind === "workspace" ? `workspace:${ref.dir}` : ref.key;
  let node = nodeCache.get(`${alias}|${id}`);
  if (node === undefined) {
    node = ref.kind === "workspace" ? workspaceNode(alias, ref.dir) : registryNode(alias, ref.key);
    nodeCache.set(`${alias}|${id}`, node);
  }
  return node;
}

// Lay out the tree like npm does: hoist as high as possible without conflicting with an existing name
const packages = {};
const cliPkg = readPkg(cliDir);
const cliImporter = lock.importers[cliDir];
const rootSpecs = [...Object.entries(cliImporter.dependencies ?? {}), ...Object.entries(cliImporter.optionalDependencies ?? {})];
const optionalRootNames = new Set(Object.keys(cliImporter.optionalDependencies ?? {}));

const placed = new Map(); // location -> node id
const declared = new Map(); // location -> Map(dependency name -> node id) declared by the package at that location
declared.set(
  "",
  new Map(rootSpecs.map(([alias, spec]) => [alias, getNode(resolveRef(alias, spec.version, cliDir), alias).id]))
);
const parentOf = (loc) => loc.slice(0, Math.max(0, loc.lastIndexOf("/node_modules/")));
const nmPath = (loc, name) => `${loc}${loc ? "/" : ""}node_modules/${name}`;

// queue of {node, parentLoc, optional}
const queue = rootSpecs.map(([alias, spec]) => ({
  node: getNode(resolveRef(alias, spec.version, cliDir), alias),
  parentLoc: "",
  optional: optionalRootNames.has(alias),
}));

while (queue.length > 0) {
  const {node, parentLoc, optional} = queue.shift();

  // Walk from the parent up to the root and find the highest node_modules that can host this node. Hoisting must stop
  // at a package that has a conflicting node placed or that itself depends on another version of the same name,
  // otherwise that package (or its subtree) would resolve the wrong version.
  let target;
  let reuse;
  for (let loc = parentLoc; ; loc = parentOf(loc)) {
    const existing = placed.get(nmPath(loc, node.name));
    const declaredId = declared.get(loc)?.get(node.name);
    if ((existing !== undefined && existing !== node.id) || (declaredId !== undefined && declaredId !== node.id)) break;
    if (existing === node.id) {
      reuse = nmPath(loc, node.name);
      break;
    }
    target = loc;
    if (loc === "") break;
  }

  if (reuse !== undefined) {
    if (!optional && !node.optional) delete packages[reuse].optional;
    continue;
  }
  if (target === undefined) throw Error(`Unable to place ${node.name} (${node.id}) below "${parentLoc}"`);

  const location = nmPath(target, node.name);
  placed.set(location, node.id);
  packages[location] = {...node.entry, ...(optional || node.optional ? {optional: true} : {})};
  declared.set(location, new Map([...node.deps, ...node.optDeps].map((d) => [d.alias, getNode(d, d.alias).id])));

  if (node.deps.length > 0) {
    packages[location].dependencies = Object.fromEntries(node.deps.map((d) => [d.alias, depSpecifier(d)]));
  }
  if (node.optDeps.length > 0) {
    packages[location].optionalDependencies = Object.fromEntries(node.optDeps.map((d) => [d.alias, depSpecifier(d)]));
  }

  for (const dep of node.deps) {
    queue.push({node: getNode(dep, dep.alias), parentLoc: location, optional: optional || node.optional});
  }
  for (const dep of node.optDeps) {
    queue.push({node: getNode(dep, dep.alias), parentLoc: location, optional: true});
  }
}

// npm validates `dependencies` ranges against the placed versions, use the exact locked version as range
function depSpecifier(ref) {
  const node = getNode(ref, ref.alias);
  return node.entry.version;
}

const sortedPackages = Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b, "en")));

const shrinkwrap = {
  name: cliPkg.name,
  version: cliPkg.version,
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": {
      name: cliPkg.name,
      version: cliPkg.version,
      dependencies: Object.fromEntries(
        rootSpecs.filter(([a]) => !optionalRootNames.has(a)).map(([a, s]) => [a, resolveRef(a, s.version, cliDir)]).map(([a, r]) => [a, getNode(r, a).entry.version])
      ),
      engines: cliPkg.engines,
    },
    ...sortedPackages,
  },
};

fs.writeFileSync(outputPath, `${JSON.stringify(shrinkwrap, null, 2)}\n`);
console.log(`Wrote ${outputPath} with ${Object.keys(sortedPackages).length} packages`);
