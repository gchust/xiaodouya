import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkApk, parseBadging, parseCertDigests } from './release-apk.mjs';

// v0.8.0 Release 上那个 APK 的真实输出（aapt2 和 apksigner 37.0.0）。
const BADGING = `package: name='com.gchust.xiaodouya' versionCode='11' versionName='0.8.0' platformBuildVersionName='17' platformBuildVersionCode='37' compileSdkVersion='37' compileSdkVersionCodename='17'
minSdkVersion:'24'
`;
const CERT = '746c7d361dd376c79385f475094df6e009d5c4e9aca892ef8804118523827268';
const CERTS = `V2 Signer: certificate DN: CN=Xiaodouya, OU=Mobile, O=gchust, C=SG
V2 Signer: certificate SHA-256 digest: ${CERT}
V2 Signer: certificate SHA-1 digest: 21485f8b1fc1e081d83afb44ebca72d82b4d44ef
V2 Signer: certificate MD5 digest: 5c2f4a2ad6d29bf6369b11f4bf720839
`;
const OTHER = 'a'.repeat(64);

test('读出包名、versionCode 和 versionName', () => {
  assert.deepEqual(parseBadging(BADGING), {
    packageName: 'com.gchust.xiaodouya',
    versionCode: 11,
    versionName: '0.8.0',
  });
});

test('读不出版本号时报错', () => {
  assert.throws(() => parseBadging('ERROR: dump failed'), /版本号/);
});

test('读出签名证书的 SHA-256，新旧两种 apksigner 格式都认', () => {
  assert.deepEqual(parseCertDigests(CERTS), [CERT]);
  assert.deepEqual(
    parseCertDigests(`Signer #1 certificate SHA-256 digest: ${CERT.toUpperCase()}\n`),
    [CERT],
  );
  // v1、v2、v3 各打一行同一张证书时只算一张。
  assert.deepEqual(parseCertDigests(`${CERTS}V3 Signer: certificate SHA-256 digest: ${CERT}\n`), [
    CERT,
  ]);
  assert.deepEqual(parseCertDigests('nothing'), []);
});

const good = {
  packageName: 'com.gchust.xiaodouya',
  versionCode: 12,
  versionName: '0.9.0',
  certs: [CERT],
};
const previous = {
  packageName: 'com.gchust.xiaodouya',
  versionCode: 11,
  versionName: '0.8.0',
  certs: [CERT],
};
const expected = { versionCode: 12, versionName: '0.9.0' };

test('版本号、包名、证书都对时通过', () => {
  assert.deepEqual(checkApk({ apk: good, expected, previous }), []);
});

test('versionCode、versionName 和要发的不一样时失败', () => {
  assert.equal(checkApk({ apk: { ...good, versionCode: 13 }, expected, previous }).length, 1);
  assert.equal(checkApk({ apk: { ...good, versionName: '0.9.1' }, expected, previous }).length, 1);
});

test('versionCode 不比上一版大时失败', () => {
  const errors = checkApk({
    apk: { ...good, versionCode: 11 },
    expected: { ...expected, versionCode: 11 },
    previous,
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /11/);
});

test('签名证书和上一版不一样时失败', () => {
  const errors = checkApk({ apk: { ...good, certs: [OTHER] }, expected, previous });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /证书/);
});

test('没有签名或有多张证书时失败', () => {
  assert.equal(checkApk({ apk: { ...good, certs: [] }, expected, previous }).length, 1);
  assert.ok(checkApk({ apk: { ...good, certs: [CERT, OTHER] }, expected, previous }).length >= 1);
});

test('包名变了时失败', () => {
  assert.equal(
    checkApk({ apk: { ...good, packageName: 'com.example' }, expected, previous }).length,
    1,
  );
});

test('没有上一版时只核对版本号', () => {
  assert.deepEqual(checkApk({ apk: good, expected, previous: null }), []);
});
