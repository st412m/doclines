// tools/scan-secrets.mjs: which lines it flags. Fake secrets are assembled from parts
// so this file itself stays clean.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { fileOptions, scanText } from '../tools/scan-secrets.mjs';

const rulesOf = (text, opts) => scanText(text, opts).flatMap((f) => f.rules);

test('scan-secrets: token shapes, key-value secrets, Authorization, LAN addresses, user paths', () => {
  const cases = [
    ['aws_key', `key ${'AKIA'}${'ABCDEFGHIJKLMNOP'}`],
    ['github_token', `${'ghp'}_${'a1B2'.repeat(9)}`],
    ['api_key', `${'sk'}-${'ant-'}${'x9Y8'.repeat(6)}`],
    ['jwt', `${'eyJ'}hbGciOiJIUzI1.${'eyJ'}zdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4`],
    ['pem', `-----BEGIN ${'RSA PRIVATE'} KEY-----`],
    ['url_credentials', `https://user:${'pa55word'}@host.example`],
    ['kv_secret', `${'password'}: ${'Hunter2-Hunter2'}`],
    ['auth_header', `${'Authorization'}: Bearer ${'abcDEF123456ghi'}`],
    ['private_ipv4', `host ${'192.168'}.1.5`],
    ['user_path', `${'C:'}\\Users\\${'someone'}\\file.txt`],
  ];
  for (const [rule, line] of cases) assert.deepEqual(rulesOf(line), [rule], line);
});

test('scan-secrets: placeholders, public addresses and shared profiles are not flagged', () => {
  for (const line of [
    `${'password'}: <your-password>`,
    `${'token'} = \${TOKEN}`,
    `${'secret'}: ***`,
    'host 8.8.8.8, 10.0.0.256, 1.10.0.0.1',
    `${'C:'}\\Users\\Public\\Documents`,
    `${'C:'}\\Users\\<name>\\file.txt`,
  ]) {
    assert.deepEqual(rulesOf(line), [], line);
  }
});

test('scan-secrets: code files skip context rules, markers, package-lock', () => {
  const kv = `const ${'token'} = ${'opts.token'};`;
  assert.deepEqual(rulesOf(kv, fileOptions('src/x.js')), []);
  assert.deepEqual(rulesOf(kv, fileOptions('README.md')), ['kv_secret']);
  assert.deepEqual(rulesOf(`${'sk'}-${'q'.repeat(24)}`, fileOptions('src/x.js')), ['api_key']);
  assert.deepEqual(rulesOf(`${'password'}: ${'Hunter2-Hunter2'} # scan-secrets:allow`), []);
  const allowFile = `// scan-secrets:${'allow-file'}\n${'password'}: ${'Hunter2-Hunter2'}`;
  assert.deepEqual(rulesOf(allowFile, fileOptions('test/x.txt')), []);
  assert.deepEqual(rulesOf(allowFile, fileOptions('docs/x.md')), ['kv_secret']);
  // The LAN and path checks have no opt-out.
  assert.deepEqual(rulesOf(`${'10.1'}.2.3 # scan-secrets:allow`), ['private_ipv4']);
  assert.deepEqual(rulesOf(`${'sk'}-${'q'.repeat(24)} ${'172.16'}.0.1`, fileOptions('package-lock.json')), ['private_ipv4']);
});

test('scan-secrets: the fake password of the fixtures would be flagged in a document', () => {
  // test/golden/ is skipped by path: every string in it comes from test/fixtures/.
  const golden = fs.readFileSync(new URL('./golden/book.md.json', import.meta.url), 'utf8');
  assert.ok(rulesOf(golden, fileOptions('test/golden/book.md.json')).includes('kv_secret'));
});
