// prebuild 生成的 build.gradle 默认用调试密钥签 release。这里改成正式密钥。
// 密钥从环境变量读取，不会写进文件。
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CONFIG = 'xiaodouyaRelease';
const CONFIG_BLOCK = `
        ${CONFIG} {
            storeFile file(System.getenv('ANDROID_KEYSTORE_PATH'))
            storePassword System.getenv('ANDROID_KEYSTORE_PASSWORD')
            keyAlias System.getenv('ANDROID_KEY_ALIAS')
            keyPassword System.getenv('ANDROID_KEY_PASSWORD')
        }`;

/** 返回 name { ... } 花括号内部的范围。只认行首的块名，注释里的不算。 */
function findBlock(text, name, start = 0, end = text.length) {
  const header = new RegExp(`^[ \\t]*${name}\\s*\\{`, 'm').exec(text.slice(start, end));
  if (!header) return null;
  const open = start + header.index + header[0].length;
  let depth = 1;
  for (let i = open; i < end; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') depth -= 1;
    if (depth === 0) return { open, close: i };
  }
  return null;
}

function requireBlock(text, name, start, end) {
  const block = findBlock(text, name, start, end);
  if (!block) throw new Error(`找不到 ${name} 块，prebuild 模板可能变了`);
  return block;
}

/** 必须限定在 release 块内替换：跨块匹配会把正式密钥错配给 debug，而 release 仍然没有签名。 */
export function patchSigning(source) {
  let gradle = source;
  const android = requireBlock(gradle, 'android');
  const configs = requireBlock(gradle, 'signingConfigs', android.open, android.close);
  if (!findBlock(gradle, CONFIG, configs.open, configs.close)) {
    gradle = gradle.slice(0, configs.open) + CONFIG_BLOCK + gradle.slice(configs.open);
  }

  const types = requireBlock(gradle, 'buildTypes');
  const release = requireBlock(gradle, 'release', types.open, types.close);
  const body = gradle.slice(release.open, release.close);
  const line = /^([ \t]*signingConfig\s+signingConfigs\.)(\w+)/m.exec(body);
  if (!line) throw new Error('找不到 release 的 signingConfig，prebuild 模板可能变了');
  if (line[2] === CONFIG) return gradle;
  if (line[2] !== 'debug') {
    throw new Error(`release 用的是未知的签名配置 ${line[2]}，prebuild 模板可能变了`);
  }
  const patched = body.replace(line[0], `${line[1]}${CONFIG}`);
  return gradle.slice(0, release.open) + patched + gradle.slice(release.close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file] = process.argv.slice(2);
  const source = readFileSync(file, 'utf8');
  const gradle = patchSigning(source);
  if (gradle !== source) writeFileSync(file, gradle);
}
