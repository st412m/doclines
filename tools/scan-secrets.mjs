#!/usr/bin/env node
// Repository hygiene: fail on anything that looks like a secret, on private LAN
// addresses (10/8, 172.16/12, 192.168/16) and on Windows user-profile paths. Walks the
// repository (`.git` and what `.gitignore` lists are skipped); test/fixtures/ and
// test/golden/ (generated from the fixtures by tools/make-golden.mjs) are skipped too.
// Reports file:line and the rule, never the matched text, so the CI log does not
// repeat a leaked secret.
//
// - In code files the key-value and Authorization rules are not counted (there they
//   match identifiers like `token = opts.token`); every token-shape rule still is.
// - A line carrying the marker scan-secrets:allow is skipped by the secret rules.
// - The marker scan-secrets:allow-file in the first 3 lines skips the secret rules for
//   the whole file (tests full of fake keys) — only under test/, ignored elsewhere.
// - package-lock.json gets the LAN and path checks only: sha512 integrity strings
//   look like mixed-case tokens.
// The LAN and path checks have no opt-out.
//
//   node tools/scan-secrets.mjs [file ...]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const SKIP = [/^test\/fixtures\//, /^test\/golden\//];
const LAN_ONLY = new Set(['package-lock.json']);
const ALLOW = 'scan-secrets:allow';
const ALLOW_FILE = 'scan-secrets:allow-file';
const CODE = /\.(?:[cm]?js|sh)$/;
const CONTEXT_RULES = new Set(['kv_secret', 'auth_header']);
const PROBE = 8192;

// Token shapes of common services, private keys, credentials in URLs.
const TOKEN_RULES = [
  ['pem', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/],
  ['aws_key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/],
  ['gitlab_token', /\bglpat-[A-Za-z0-9_-]{20,}/],
  ['npm_token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['api_key', /\bsk-(?:ant-|proj-|or-v1-|live_|test_)?[A-Za-z0-9_-]{20,}/],
  ['google_key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['slack_token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['url_credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"<>]+:[^\s/@'"<>]{3,}@/i],
];
// key = value / key: value with a secret-sounding key; placeholders (<…>, ${…}, ***) do
// not count.
const KV_SECRET =
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*["']?(?![<$*{[(]|\s|["'])[^\s"',;]{6,}/i;
const AUTH_HEADER = /\bAuthorization\s*:\s*(?:Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/i;

const OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
const PRIVATE_V4 = new RegExp(
  String.raw`(?<![\d.])(?:10\.${OCTET}\.${OCTET}\.${OCTET}|172\.(?:1[6-9]|2\d|3[01])\.${OCTET}\.${OCTET}|192\.168\.${OCTET}\.${OCTET})(?!\d|\.\d)`,
);
// A user profile on Windows (C:\Users\<name>); Public and Default are not anyone's.
const USER_PATH = /\b[A-Za-z]:[\\/]+Users[\\/]+(?!(?:Public|Default)\b|[<%$])[^\\/\s"'<>]+/i;

// .gitignore lines as matchers of a repo-relative POSIX path: `name/` a directory
// anywhere, `name` or `*.ext` a basename anywhere, a pattern with an inner or leading
// `/` anchored at the root. Negation (`!`) is not supported and is ignored.
function ignoreRules(root) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  } catch {
    return [];
  }
  const rules = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes('/');
    line = line.replace(/^\//, '');
    const re = new RegExp(
      `^${line
        .split('**')
        .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
        .join('.*')}$`,
    );
    rules.push({ re, dirOnly, anchored });
  }
  return rules;
}

const ignored = (rules, rel, isDir) =>
  rules.some((r) => (!r.dirOnly || isDir) && r.re.test(r.anchored ? rel : path.posix.basename(rel)));

// Repo-relative POSIX paths of the files to scan.
function repoFiles(root) {
  const rules = ignoreRules(root);
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.name === '.git' || ignored(rules, rel, e.isDirectory())) continue;
      if (e.isDirectory()) walk(rel);
      else if (e.isFile()) out.push(rel);
    }
  };
  walk('');
  return out.sort();
}

function readText(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, PROBE).includes(0)) return null; // binary
  const text = buf.toString('utf8');
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r/g, '');
}

// scanText options for a repo-relative POSIX path.
export function fileOptions(rel) {
  return { lanOnly: LAN_ONLY.has(rel), code: CODE.test(rel), allowFile: rel.startsWith('test/') };
}

// [{ line, rules[] }] for one text; lanOnly skips the secret rules, code drops the
// context rules, allowFile honours the allow-file marker.
export function scanText(text, { lanOnly = false, code = false, allowFile = false } = {}) {
  const lines = text.split('\n');
  const skipSecrets = lanOnly || (allowFile && lines.slice(0, 3).some((l) => l.includes(ALLOW_FILE)));
  const found = [];
  for (const [i, line] of lines.entries()) {
    const rules = [];
    if (!skipSecrets && !line.includes(ALLOW)) {
      for (const [rule, re] of TOKEN_RULES) if (re.test(line)) rules.push(rule);
      if (!code && KV_SECRET.test(line)) rules.push('kv_secret');
      if (!code && AUTH_HEADER.test(line)) rules.push('auth_header');
    }
    if (PRIVATE_V4.test(line)) rules.push('private_ipv4');
    if (USER_PATH.test(line)) rules.push('user_path');
    if (rules.length) found.push({ line: i + 1, rules: rules.filter((r) => !(code && CONTEXT_RULES.has(r))) });
  }
  return found.filter((f) => f.rules.length);
}

const toPosix = (p) => p.split(path.sep).join('/');

function realNative(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

// A file named on the command line → { abs, rel, name }. Root and file are both
// resolved with the native realpath, so 8.3 short names (RUNNER~1) and long
// names compare equal. `rel` is the repo-relative POSIX path, or null for a file
// outside the repo (another drive included: path.relative then returns an absolute
// path); such a file is reported by the path as given and never counts as under test/.
function argTarget(arg, rootReal) {
  const abs = realNative(path.resolve(arg));
  const r = path.relative(rootReal, abs);
  const inside = r !== '' && !r.startsWith('..') && !path.isAbsolute(r);
  return { abs, rel: inside ? toPosix(r) : null, name: inside ? toPosix(r) : arg };
}

function main(args) {
  const rootReal = realNative(ROOT);
  const targets = args.length
    ? args.map((a) => argTarget(a, rootReal))
    : repoFiles(ROOT).map((r) => ({ abs: path.join(ROOT, r), rel: r, name: r }));
  let findings = 0;
  let scanned = 0;
  const flagged = new Set();
  for (const { abs, rel, name } of targets) {
    if (rel !== null && SKIP.some((re) => re.test(rel))) continue;
    let text;
    try {
      if (!fs.statSync(abs).isFile()) continue;
      text = readText(abs);
    } catch (e) {
      // An unreadable file is a finding of that file, reported like any other.
      scanned++;
      console.log(`${name}: cannot read (${e.code ?? e.message})`);
      findings++;
      flagged.add(name);
      continue;
    }
    if (text === null) continue;
    scanned++;
    const opts = rel === null ? { lanOnly: false, code: CODE.test(abs), allowFile: false } : fileOptions(rel);
    for (const f of scanText(text, opts)) {
      console.log(`${name}:${f.line}: ${f.rules.join(', ')}`);
      findings++;
      flagged.add(name);
    }
  }
  console.log(
    findings
      ? `scan-secrets: ${findings} finding(s) in ${flagged.size} of ${scanned} file(s)`
      : `scan-secrets: ${scanned} file(s) clean`,
  );
  return findings ? 1 : 0;
}

function isMain() {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

// Run only as a script, not when imported by tests.
if (isMain()) process.exitCode = main(process.argv.slice(2));
