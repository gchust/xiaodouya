// 这里只验证文本替换。Gradle 是否真的用这个配置签名，要靠一次真实的发布构建。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patchSigning } from './android-signing.mjs';

const DEBUG_CONFIG = `signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }`;

// 摘自 Expo prebuild 生成的 apps/mobile/android/app/build.gradle（该目录不进仓库）。
const EXPO_TEMPLATE = `android {
    defaultConfig {
        buildConfigField "String", "REACT_NATIVE_RELEASE_LEVEL", "\\"\${findProperty('reactNativeReleaseLevel') ?: 'stable'}\\""
    }
    ${DEBUG_CONFIG}
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
            def enableShrinkResources = findProperty('android.enableShrinkResourcesInReleaseBuilds') ?: 'false'
            shrinkResources enableShrinkResources.toBoolean()
        }
    }
}
`;

const buildTypes = (inner) => `android {
    ${DEBUG_CONFIG}
    buildTypes {
${inner}
    }
}
`;

function signingOf(gradle, type) {
  const start = gradle.indexOf(`${type} {`, gradle.indexOf('buildTypes'));
  const body = gradle.slice(start, gradle.indexOf('}', start));
  return /^\s*signingConfig\s+signingConfigs\.(\w+)/m.exec(body)?.[1];
}

test('release 换成正式密钥，debug 不变', () => {
  const gradle = patchSigning(EXPO_TEMPLATE);
  assert.equal(signingOf(gradle, 'release'), 'xiaodouyaRelease');
  assert.equal(signingOf(gradle, 'debug'), 'debug');
  assert.match(gradle, /signingConfigs \{\s+xiaodouyaRelease \{/);
  assert.match(gradle, /storeFile file\(System\.getenv\('ANDROID_KEYSTORE_PATH'\)\)/);
  assert.match(gradle, /storeFile file\('debug\.keystore'\)/);
});

test('重复执行不再改动', () => {
  const once = patchSigning(EXPO_TEMPLATE);
  assert.equal(patchSigning(once), once);
});

test('release 排在 debug 前且没有 signingConfig 时报错，不能改到 debug 上', () => {
  const gradle = buildTypes(`        release {
            minifyEnabled true
        }
        debug {
            signingConfig signingConfigs.debug
        }`);
  assert.throws(() => patchSigning(gradle), /release 的 signingConfig/);
});

test('注释掉的 signingConfig 不算数', () => {
  const gradle = buildTypes(`        release {
            // signingConfig signingConfigs.debug
            minifyEnabled true
        }
        staging {
            signingConfig signingConfigs.debug
        }`);
  assert.throws(() => patchSigning(gradle), /release 的 signingConfig/);
});

test('没有 signingConfigs 块时报错，不能引用不存在的配置', () => {
  const gradle = `android {
    buildTypes {
        release {
            signingConfig signingConfigs.debug
        }
    }
}
`;
  assert.throws(() => patchSigning(gradle), /signingConfigs 块/);
});

test('之前只改了一半的文件也要改完', () => {
  const gradle = `android {
    signingConfigs {
        xiaodouyaRelease {
        }
        debug {
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.debug
        }
    }
}
`;
  assert.equal(signingOf(patchSigning(gradle), 'release'), 'xiaodouyaRelease');
});

test('release 用了未知的签名配置时报错，不能当作已经改好', () => {
  const gradle = buildTypes(`        release {
            signingConfig signingConfigs.somethingElse
        }`);
  assert.throws(() => patchSigning(gradle), /未知的签名配置/);
});
