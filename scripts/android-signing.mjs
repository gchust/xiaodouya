// prebuild 生成的 build.gradle 默认用调试密钥签 release。这里改成正式密钥。
// 密钥从环境变量读取，不会写进文件。
import { readFileSync, writeFileSync } from 'node:fs';

const [file] = process.argv.slice(2);
let gradle = readFileSync(file, 'utf8');
if (!gradle.includes('xiaodouyaRelease')) {
  gradle = gradle.replace(
    /signingConfigs\s*\{/,
    `signingConfigs {
        xiaodouyaRelease {
            storeFile file(System.getenv('ANDROID_KEYSTORE_PATH'))
            storePassword System.getenv('ANDROID_KEYSTORE_PASSWORD')
            keyAlias System.getenv('ANDROID_KEY_ALIAS')
            keyPassword System.getenv('ANDROID_KEY_PASSWORD')
        }`,
  );
  const releaseBlock =
    /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig\s+signingConfigs\.debug/;
  if (!releaseBlock.test(gradle))
    throw new Error('找不到 release 的 signingConfig，prebuild 模板可能变了');
  gradle = gradle.replace(releaseBlock, '$1signingConfig signingConfigs.xiaodouyaRelease');
  writeFileSync(file, gradle);
}
