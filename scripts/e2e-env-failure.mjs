#!/usr/bin/env node
// 判断一条 Maestro 流程失败是不是模拟器环境断开。
// 只有这种失败才允许整组重跑，判错的代价是掩盖 App 的问题，所以只看“第一个错误”：
// 断言失败之后断开，收尾时日志里也会出现 device offline，那仍然是断言失败。
//
// 用法：node scripts/e2e-env-failure.mjs <maestro.log> <从第几字节算这条流程> [流程的 device-logcat.txt]
// 退出码 0 表示环境断开（并打印原因），1 表示不是。
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const APP = 'com.gchust.xiaodouya';

// host:transport 失败来自 adb server，它说设备不在；DeviceServerDied 来自 Maestro 和设备之间的 gRPC 通道。
const ENV_SIGNATURES = [
  { name: 'device offline', pattern: /Command failed \(host:transport:[^)]*\): device offline/ },
  {
    name: 'device not found',
    pattern: /Command failed \(host:transport:[^)]*\): device '[^']*' not found/,
  },
  { name: 'DeviceServerDiedException', pattern: /maestro\.android\.DeviceServerDiedException/ },
];

const LOG_LINE = /^\d\d:\d\d:\d\d\.\d{3} \[/;

// 只有这句笼统的错误要看下一行的异常类名；其他错误（断言失败等）的原因就写在这一行里。
const GENERIC_ERROR = /\[ERROR\] maestro\.cli\.runner\.TestRunner\S*: Failed to run flow$/;

/** 第一条 [ERROR]，是“Failed to run flow”时连同下一行的异常类名。 */
function firstError(log) {
  const lines = log.split('\n');
  const start = lines.findIndex((line) => LOG_LINE.test(line) && line.includes('[ERROR]'));
  if (start === -1) return null;
  const next = lines[start + 1] ?? '';
  return GENERIC_ERROR.test(lines[start]) && !LOG_LINE.test(next)
    ? `${lines[start]}\n${next}`
    : lines[start];
}

/** logcat 里有 App 自己的崩溃就不算环境问题，哪怕同时断开了。 */
function appCrashed(logcat) {
  const lines = logcat.split('\n');
  return lines.some(
    (line, i) =>
      line.includes('FATAL EXCEPTION') &&
      lines.slice(i, i + 3).some((near) => near.includes(`Process: ${APP}`)),
  );
}

export function classifyFailure(log, logcat = '') {
  const error = firstError(log);
  if (error === null) return { env: false, reason: '日志里没有 Maestro 记录的错误' };
  const signature = ENV_SIGNATURES.find(({ pattern }) => pattern.test(error));
  if (!signature) return { env: false, reason: error.split('\n')[0] };
  if (appCrashed(logcat)) return { env: false, reason: `${signature.name}，但 App 崩溃了` };
  return { env: true, reason: signature.name };
}

function main([logPath, offset = '0', logcatPath]) {
  if (!logPath) {
    console.error('用法：e2e-env-failure.mjs <maestro.log> <字节偏移> [device-logcat.txt]');
    process.exitCode = 2;
    return;
  }
  if (!existsSync(logPath)) {
    console.log('没有 Maestro 日志');
    process.exitCode = 1;
    return;
  }
  const log = readFileSync(logPath).subarray(Number(offset)).toString('utf8');
  const logcat = logcatPath && existsSync(logcatPath) ? readFileSync(logcatPath, 'utf8') : '';
  const { env, reason } = classifyFailure(log, logcat);
  console.log(reason);
  process.exitCode = env ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
