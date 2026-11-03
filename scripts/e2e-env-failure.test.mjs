import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyFailure } from './e2e-env-failure.mjs';

// 下面的日志摘自真实的 CI 运行，只留判断要用的行。

// run 41551513433 的 files 组，流程 03a：Maestro 刚启动就断开。
const OFFLINE_AT_LAUNCH = `00:28:33.843 [ INFO] maestro.Maestro.launchApp$lambda$6: Stopping com.gchust.xiaodouya app during launch
00:28:33.848 [ERROR] maestro.orchestra.Orchestra.executeCommands: [Command execution] CommandFailed: Command failed (host:transport:emulator-5554): device offline
00:28:33.879 [ WARN] maestro.orchestra.debug.ArtifactsGenerator.captureStepHierarchy: Failed to capture step hierarchy
maestro.android.DeviceServerDiedException: Device server died during 'deviceInfo' on emulator-5554 (80ms since last byte, connection age 1913ms): StatusRuntimeException: UNAVAILABLE
`;

// 同一次运行，流程 03b：等上传时断开，异常类名在 [ERROR] 的下一行。
const DIED_DURING_WAIT = `00:31:26.566 [ INFO] maestro.cli.runner.MaestroCommandRunner.runCommands$lambda$0: Assert that id: uploads-empty is visible RUNNING
00:31:34.861 [ERROR] maestro.cli.runner.TestRunner.runCatching-ta8aW1Q: Failed to run flow
maestro.android.DeviceServerDiedException: Device server died during 'viewHierarchy' on emulator-5554 (816ms since last byte, connection age 49675ms): StatusRuntimeException: UNAVAILABLE: End of stream or IOException
	at maestro.android.AndroidDeviceConnection.onGrpcDeath(AndroidDeviceConnection.kt:319)
`;

// 同一次运行，流程 03b 的重跑：断言失败。
const ASSERTION = `00:33:30.171 [ INFO] maestro.cli.runner.MaestroCommandRunner.runCommands$lambda$0: Assert that "Control \${RUN_ID}" is not visible RUNNING
00:33:40.310 [ERROR] maestro.orchestra.Orchestra.executeCommands: [Command execution] CommandFailed: Assertion is false: "Control 1793665645" is not visible
00:33:40.442 [ INFO] maestro.Maestro.takeScreenshot: Taking screenshot
`;

test('Maestro 启动时 device offline 算环境断开', () => {
  assert.deepEqual(classifyFailure(OFFLINE_AT_LAUNCH), { env: true, reason: 'device offline' });
});

test('等待中 DeviceServerDiedException 算环境断开', () => {
  assert.deepEqual(classifyFailure(DIED_DURING_WAIT), {
    env: true,
    reason: 'DeviceServerDiedException',
  });
});

test('adb 说找不到设备也算环境断开', () => {
  const log = `15:24:17.711 [ERROR] maestro.orchestra.Orchestra.executeCommands: [Command execution] CommandFailed: Command failed (host:transport:emulator-5554): device 'emulator-5554' not found\n`;
  assert.deepEqual(classifyFailure(log), { env: true, reason: 'device not found' });
});

test('断言失败不算', () => {
  assert.equal(classifyFailure(ASSERTION).env, false);
});

test('断言失败之后才断开，还是断言失败', () => {
  // 旧的 grep 只看整个日志有没有这两个词，这种情况会被当成断开，重跑就把断言失败盖住了。
  const log = `${ASSERTION}00:33:41.000 [ WARN] maestro.orchestra.debug.ArtifactsGenerator.captureScreenshot: Failed to capture screenshot
maestro.android.DeviceServerDiedException: Device server died during 'screenshot' on emulator-5554
00:33:41.500 [ERROR] maestro.cli.runner.TestRunner.runCatching-ta8aW1Q: Failed to run flow
java.io.IOException: Command failed (host:transport:emulator-5554): device offline
`;
  assert.equal(classifyFailure(log).env, false);
});

test('断言失败的下一行紧跟着断开的异常，也还是断言失败', () => {
  const log = `00:33:40.310 [ERROR] maestro.orchestra.Orchestra.executeCommands: [Command execution] CommandFailed: Assertion is false: "Control 1793665645" is not visible
maestro.android.DeviceServerDiedException: Device server died during 'screenshot' on emulator-5554
java.io.IOException: Command failed (host:transport:emulator-5554): device offline
`;
  assert.equal(classifyFailure(log).env, false);
});

test('找不到元素不算', () => {
  const log = `10:00:00.000 [ERROR] maestro.orchestra.Orchestra.executeCommands: [Command execution] CommandFailed: Element not found: Id matching regex: tab-recall\n`;
  assert.equal(classifyFailure(log).env, false);
});

test('App 自己崩溃时不算，哪怕设备也断开了', () => {
  const logcat = `11-03 00:31:30.000 E/AndroidRuntime( 3999): FATAL EXCEPTION: main
11-03 00:31:30.000 E/AndroidRuntime( 3999): Process: com.gchust.xiaodouya, PID: 3999
`;
  assert.equal(classifyFailure(DIED_DURING_WAIT, logcat).env, false);
});

test('系统组件崩溃不影响判断', () => {
  const logcat = `11-03 00:31:30.000 E/AndroidRuntime( 1200): FATAL EXCEPTION: main
11-03 00:31:30.000 E/AndroidRuntime( 1200): Process: com.android.documentsui, PID: 1200
`;
  assert.equal(classifyFailure(DIED_DURING_WAIT, logcat).env, true);
});

test('日志里没有错误不算', () => {
  assert.equal(classifyFailure('00:00:00.000 [ INFO] something\n').env, false);
  assert.equal(classifyFailure('').env, false);
});
