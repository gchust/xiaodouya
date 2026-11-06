#!/usr/bin/env node
// 发布前核对签名 APK：版本号是这次要发的、比上一版大，签名证书和上一版 Release 的一样。
// 证书换了的话，装着旧版的手机覆盖安装会失败，只能卸载重装，没同步的数据会丢。
//
//   node scripts/release-apk.mjs inspect <apk>                                  打印 JSON
//   node scripts/release-apk.mjs check <apk> <versionName> <versionCode> [上一版 apk]
//
// 用 ANDROID_HOME（默认 ~/Android/Sdk）里最新的 build-tools 的 aapt2 和 apksigner。
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseBadging(text) {
  const match = /^package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'/m.exec(text);
  if (!match) throw new Error('读不出 APK 的版本号');
  return { packageName: match[1], versionCode: Number(match[2]), versionName: match[3] };
}

/** apksigner 新版写 “V2 Signer: certificate SHA-256 digest”，旧版写 “Signer #1 certificate SHA-256 digest”。 */
export function parseCertDigests(text) {
  const digests = new Set();
  for (const match of text.matchAll(/certificate SHA-256 digest: ([0-9a-fA-F]{64})/g)) {
    digests.add(match[1].toLowerCase());
  }
  return [...digests];
}

/** 返回问题列表，空的表示通过。previous 是 null 时是第一次发布，只核对版本号。 */
export function checkApk({ apk, expected, previous }) {
  const errors = [];
  if (apk.versionCode !== expected.versionCode) {
    errors.push(`APK 里的 versionCode 是 ${apk.versionCode}，要发的是 ${expected.versionCode}`);
  }
  if (apk.versionName !== expected.versionName) {
    errors.push(`APK 里的 versionName 是 ${apk.versionName}，要发的是 ${expected.versionName}`);
  }
  if (apk.certs.length !== 1) {
    errors.push(`APK 应该正好有一张签名证书，实际是 ${apk.certs.length} 张`);
  }
  if (!previous) return errors;
  if (apk.packageName !== previous.packageName) {
    errors.push(`包名从 ${previous.packageName} 变成了 ${apk.packageName}`);
  }
  if (apk.versionCode <= previous.versionCode) {
    errors.push(
      `versionCode ${apk.versionCode} 不比上一版的 ${previous.versionCode} 大，手机装不上`,
    );
  }
  if (apk.certs.length === 1 && previous.certs.join() !== apk.certs.join()) {
    errors.push(
      `签名证书 SHA-256 ${apk.certs[0]} 和上一版的 ${previous.certs.join(', ')} 不一样，装着旧版的手机覆盖安装会失败`,
    );
  }
  return errors;
}

function buildTool(name) {
  const root = join(process.env.ANDROID_HOME || join(homedir(), 'Android/Sdk'), 'build-tools');
  const versions = existsSync(root)
    ? readdirSync(root).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    : [];
  for (const version of versions.reverse()) {
    const path = join(root, version, name);
    if (existsSync(path)) return path;
  }
  throw new Error(`找不到 ${name}（Android SDK 的 build-tools），请设置 ANDROID_HOME`);
}

export function inspect(file) {
  const badging = parseBadging(
    execFileSync(buildTool('aapt2'), ['dump', 'badging', file], { encoding: 'utf8' }),
  );
  // 签名无效时 apksigner 退出码不是 0，execFileSync 会抛错。
  const certs = parseCertDigests(
    execFileSync(buildTool('apksigner'), ['verify', '--print-certs', file], { encoding: 'utf8' }),
  );
  return { ...badging, certs };
}

function main(argv) {
  const [command, file, ...rest] = argv;
  if (command === 'inspect' && file) {
    console.log(JSON.stringify(inspect(file)));
    return 0;
  }
  if (command === 'check' && file && rest.length >= 2) {
    const [versionName, code, previousFile] = rest;
    const apk = inspect(file);
    const previous = previousFile ? inspect(previousFile) : null;
    const errors = checkApk({
      apk,
      expected: { versionName, versionCode: Number(code) },
      previous,
    });
    for (const error of errors) console.log(`::error::${error}`);
    if (errors.length > 0) return 1;
    console.log(
      `APK 核对通过：${apk.packageName} ${apk.versionName}（${apk.versionCode}），证书 SHA-256 ${apk.certs[0]}` +
        (previous
          ? `，和上一版 ${previous.versionName}（${previous.versionCode}）同一张`
          : '，没有上一版可比'),
    );
    return 0;
  }
  throw new Error(
    '用法：release-apk.mjs inspect <apk> | check <apk> <versionName> <versionCode> [上一版 apk]',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
