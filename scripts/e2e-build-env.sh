#!/usr/bin/env bash
# E2E 构建打进包里的环境变量。android-build.sh 和 apk-key.mjs 都从这里取：
# 变量写在这一个地方，缓存键才不会漏掉构建时用到的值。
export EXPO_PUBLIC_E2E=1
export EXPO_PUBLIC_API_URL="${EXPO_PUBLIC_API_URL:-http://10.0.2.2:8787}"
# 假地址：没有它分享入口不出现。流程 11b 只检查链接，不会真的打开。
export EXPO_PUBLIC_SHARE_BASE_URL="${EXPO_PUBLIC_SHARE_BASE_URL:-https://share.example.test}"
export ANDROID_ARCHS="${ANDROID_ARCHS:-x86_64}"
