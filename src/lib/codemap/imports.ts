// Which repo files one source file imports (docs/runner.md "Code map"). Line and regex based, no parser and no model:
// TS/JS relative imports, Python modules, Rust `mod`/`use crate::…` paths, Swift `import <Target>` of a SwiftPM package
// in the repo. An import that does not name a file in the tree is dropped, never guessed. Pure.
import path from 'node:path';

/** The repo's file list and its SwiftPM targets: what an import may resolve to. */
export interface Tree { files: Set<string>; swift: SwiftTarget[] }
/** One SwiftPM target: its package's dir ('' = repo root), its name and its source dir (ends with `/`). */
export interface SwiftTarget { pkg: string; name: string; dir: string }

const JS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** Files a map reads. */
export const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rs|swift)$/;
export const isPackageSwift = (f: string) => f === 'Package.swift' || f.endsWith('/Package.swift');

const dirOf = (f: string) => { const d = path.posix.dirname(f); return d === '.' ? '' : d; };
const join = (...parts: string[]) => { const p = path.posix.normalize(parts.filter(Boolean).join('/')); return p === '.' ? '' : p; };
const first = (tree: Tree, cands: string[]) => cands.find((c) => c && !c.startsWith('..') && tree.files.has(c));

/** One pass over the text: `//` and block comments dropped. With `hide`, each '…' or "…" string becomes `'\u0001<n>'`
 *  (its text in `strings[n]`) and a template literal becomes an empty one, so code inside a string never looks like an
 *  import; without it strings are kept as they are. `#` comments are not touched. */
export function scan(text: string, hide = false): { code: string; strings: string[] } {
  let out = '', i = 0;
  const strings: string[] = [];
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; out += ' '; continue; }
    if (c === '`') {
      const j = templateEnd(text, i);
      out += hide ? '``' + '\n'.repeat(text.slice(i, j).split('\n').length - 1) : text.slice(i, j);
      i = j; continue;
    }
    if (c === '"' || c === "'") {
      const j = quoteEnd(text, i);
      if (!hide) out += text.slice(i, j + 1);
      else { out += `${c}\u0001${strings.length}${c}`; strings.push(text.slice(i + 1, j)); }
      i = j + 1; continue;
    }
    out += c; i++;
  }
  return { code: out, strings };
}
/** The index of the closing quote of the '…' or "…" string at `i` (a string ends at a newline). */
function quoteEnd(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length && text[j] !== text[i] && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
  return j;
}
/** The index after the template literal at `i`, nested `${ … }` and templates inside them included. */
function templateEnd(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === '\\') { j += 2; continue; }
    if (text[j] === '`') return j + 1;
    if (text[j] === '$' && text[j + 1] === '{') {
      let depth = 1;
      j += 2;
      while (j < text.length && depth > 0) {
        const c = text[j];
        if (c === '`') { j = templateEnd(text, j); continue; }
        if (c === '"' || c === "'") { j = quoteEnd(text, j) + 1; continue; }
        if (c === '{') depth++; else if (c === '}') depth--;
        j++;
      }
      continue;
    }
    j++;
  }
  return text.length;
}
/** The text without `//` and block comments; strings are kept. */
export const stripComments = (text: string) => scan(text).code;

// ---------- TS / JS ----------

// On scan(…, true) output: a specifier is `'\u0001<n>'`. Static forms start a statement; the lazy span is bounded so a
// long run of "import" words cannot make the match quadratic.
const JS_SPEC = [
  /(?:^|[;}])[ \t]*(?:import|export)\s[^;'"`]{0,2000}?\bfrom\s*(['"])\u0001(\d+)\1/gm,
  /(?:^|[;}])[ \t]*import\s*(['"])\u0001(\d+)\1/gm,
  /\b(?:require|import)\s*\(\s*(['"])\u0001(\d+)\1\s*\)/g,
];

function jsImports(file: string, text: string, tree: Tree): string[] {
  const { code, strings } = scan(text, true), out: string[] = [];
  for (const re of JS_SPEC) for (const m of code.matchAll(re)) {
    const spec = strings[Number(m[2])] ?? '';
    if (!spec.startsWith('./') && !spec.startsWith('../')) continue;   // a package name, never a repo file
    const base = join(dirOf(file), spec);
    const swapped = base.replace(/\.(m|c)?js(x?)$/, (_s, mc = '', x = '') => `.${mc ?? ''}ts${x}`);
    const exts = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
    const hit = first(tree, [base, swapped, ...exts.map((e) => base + e), ...exts.map((e) => `${base}/index${e}`)]);
    if (hit) out.push(hit);
  }
  return out;
}

// ---------- Python ----------

/** The dir a module name is read from for `file`: the dir above its top package (a dir with `__init__.py`). */
function pyRoot(file: string, tree: Tree): string {
  let d = dirOf(file);
  while (d && tree.files.has(`${d}/__init__.py`)) d = dirOf(d);
  return d;
}
const pyModule = (tree: Tree, dir: string, dotted: string) =>
  first(tree, [join(dir, dotted.replace(/\./g, '/') + '.py'), join(dir, dotted.replace(/\./g, '/'), '__init__.py')]);

/** Python text with every string's contents ('…', "…", '''…''', """…""") and every `#` comment blanked; newlines kept. */
function pyCode(text: string): string {
  let out = '', i = 0;
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  while (i < text.length) {
    const c = text[i];
    if (c === '#') { const e = text.indexOf('\n', i); const j = e < 0 ? text.length : e; out += blank(text.slice(i, j)); i = j; continue; }
    if (c !== '"' && c !== "'") { out += c; i++; continue; }
    const q = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
    let j = i + q.length;
    while (j < text.length && !text.startsWith(q, j) && (q.length === 3 || text[j] !== '\n')) j += text[j] === '\\' ? 2 : 1;
    j = Math.min(text.length, j + (text.startsWith(q, j) ? q.length : 0));
    out += blank(text.slice(i, j)); i = j;
  }
  return out;
}

function pyImports(file: string, text: string, tree: Tree): string[] {
  const out: string[] = [];
  // string contents and # comments are blanked (lines kept); a parenthesised name list becomes one line
  const lines = pyCode(text).replace(/\(([^()]*)\)/g, (_m, inner: string) => inner.replace(/\s*\n\s*/g, ' ')).split('\n');
  const roots = [...new Set([pyRoot(file, tree), ''])];
  const names = (s: string) => s.split('#')[0].split(',').map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter((n) => /^[\w.]+$/.test(n));
  for (const line of lines) {
    let m = /^\s*import\s+(.+)$/.exec(line);
    if (m) { for (const n of names(m[1])) { const hit = roots.map((r) => pyModule(tree, r, n)).find(Boolean); if (hit) out.push(hit); } continue; }
    m = /^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+)$/.exec(line);
    if (!m) continue;
    const [, dots, mod, what] = m;
    let dirs = roots;
    if (dots) { let d = dirOf(file); for (let k = 1; k < dots.length; k++) d = dirOf(d); dirs = [d]; }
    for (const dir of dirs) {
      const subs = names(what).map((n) => pyModule(tree, dir, mod ? `${mod}.${n}` : n)).filter((x): x is string => !!x);
      const own = mod ? pyModule(tree, dir, mod) : undefined;
      if (subs.length || own) { out.push(...subs); if (own && !subs.length) out.push(own); break; }
    }
  }
  return out;
}

// ---------- Rust ----------

/** The crate's `src/` dir for a file under a `Cargo.toml`, '' when the file is in none. */
function crateSrc(file: string, tree: Tree): string {
  for (let d = dirOf(file); ; d = dirOf(d)) {
    if (tree.files.has(join(d, 'Cargo.toml')) && (file.startsWith(join(d, 'src') + '/'))) return join(d, 'src');
    if (!d) return '';
  }
}
const isRoot = (f: string) => /(^|\/)(lib|main|mod)\.rs$/.test(f);
/** The dir a file's child modules live in. */
const childDir = (f: string) => isRoot(f) ? dirOf(f) : f.replace(/\.rs$/, '');
const rsModule = (tree: Tree, dir: string, segs: string[]) => {
  for (let k = segs.length; k > 0; k--) {
    const hit = first(tree, [join(dir, ...segs.slice(0, k)) + '.rs', join(dir, ...segs.slice(0, k), 'mod.rs')]);
    if (hit) return hit;
  }
  return undefined;
};

function rsImports(file: string, text: string, tree: Tree): string[] {
  const src = crateSrc(file, tree);
  if (!src) return [];
  const code = stripComments(text), out: string[] = [];
  for (const m of code.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm)) {
    const hit = rsModule(tree, childDir(file), [m[1]]);
    if (hit) out.push(hit);
  }
  for (const m of code.matchAll(/(?:^|[;{}])[ \t]*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]{1,2000});/gm)) {
    for (const segs of useTree(m[1].replace(/\s+as\s+\w+/g, '').replace(/\s+/g, ''))) {
      let dir: string;
      if (segs[0] === 'crate') dir = src;
      else if (segs[0] === 'self') dir = childDir(file);
      else if (segs[0] === 'super') { dir = dirOf(childDir(file)); while (segs[1] === 'super') { segs.shift(); dir = dirOf(dir); } }
      else continue;   // another crate
      const hit = rsModule(tree, dir, segs.slice(1).filter((s) => /^\w+$/.test(s) && s !== 'self' && s !== 'super'));
      if (hit && hit !== file) out.push(hit);
    }
  }
  return out;
}

/** The paths of a Rust use tree without spaces: `crate::{a::{x::X, y}, b}` → crate/a/x/X, crate/a/y, crate/b. */
export function useTree(s: string): string[][] {
  const at = s.indexOf('{');
  if (at < 0) return [s.split('::').filter(Boolean)];
  const prefix = s.slice(0, at).split('::').filter(Boolean), inner = s.slice(at + 1, s.lastIndexOf('}')), parts: string[] = [];
  let depth = 0, from = 0;
  for (let i = 0; i <= inner.length; i++) {
    if (inner[i] === '{') depth++; else if (inner[i] === '}') depth--;
    else if (i === inner.length || (inner[i] === ',' && depth === 0)) { if (i > from) parts.push(inner.slice(from, i)); from = i + 1; }
  }
  return parts.flatMap((p) => useTree(p).map((t) => [...prefix, ...t]));
}

// ---------- Swift (SwiftPM) ----------

/** The targets a Package.swift declares. A `.target(name:)` inside a `dependencies: [...]` list names a dependency, not a target. */
export function swiftTargets(pkgFile: string, text: string): SwiftTarget[] {
  const code = stripComments(text), pkg = dirOf(pkgFile), skip: [number, number][] = [];
  for (const m of code.matchAll(/\bdependencies\s*:\s*\[/g)) {
    let depth = 0, i = m.index! + m[0].length - 1;
    for (; i < code.length; i++) { if (code[i] === '[') depth++; else if (code[i] === ']' && --depth === 0) break; }
    skip.push([m.index!, i]);
  }
  const out: SwiftTarget[] = [];
  for (const m of code.matchAll(/\.(target|executableTarget|testTarget)\s*\(/g)) {
    if (skip.some(([a, b]) => m.index! > a && m.index! < b)) continue;
    let depth = 0, i = m.index! + m[0].length - 1;
    for (; i < code.length; i++) { if (code[i] === '(') depth++; else if (code[i] === ')' && --depth === 0) break; }
    const args = code.slice(m.index!, i);
    const name = /\bname\s*:\s*"([^"]+)"/.exec(args)?.[1];
    if (!name) continue;
    const p = /\bpath\s*:\s*"([^"]+)"/.exec(args)?.[1] ?? `${m[1] === 'testTarget' ? 'Tests' : 'Sources'}/${name}`;
    out.push({ pkg, name, dir: join(pkg, p) + '/' });
  }
  return out;
}

function swiftImports(file: string, text: string, tree: Tree): string[] {
  const out: string[] = [];
  for (const m of stripComments(text).matchAll(/^[ \t]*(?:@\w+\s+)*import\s+(?:(?:struct|class|enum|protocol|func|var|let|typealias)\s+)?(\w+)/gm)) {
    const named = tree.swift.filter((t) => t.name === m[1]);
    // the importing file's own package wins; else the name must be unique in the repo
    const own = named.filter((t) => !t.pkg || file.startsWith(t.pkg + '/'));
    const pick = own.length ? own.sort((a, b) => b.pkg.length - a.pkg.length)[0] : named.length === 1 ? named[0] : undefined;
    if (pick && !file.startsWith(pick.dir)) out.push(pick.dir);
  }
  return out;
}

/** The repo files (or SwiftPM target dirs, ending in `/`) that `file` imports, without duplicates. */
export function importsOf(file: string, text: string, tree: Tree): string[] {
  const got = JS.test(file) ? jsImports(file, text, tree) : file.endsWith('.py') ? pyImports(file, text, tree)
    : file.endsWith('.rs') ? rsImports(file, text, tree) : file.endsWith('.swift') && !isPackageSwift(file) ? swiftImports(file, text, tree) : [];
  return [...new Set(got)].filter((t) => t !== file);
}
