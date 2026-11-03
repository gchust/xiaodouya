package expo.modules.appupdate

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

/**
 * 应用内更新用到的几件 JS 做不了的事。下载和调起安装界面用 expo-file-system 和 expo-intent-launcher。
 */
class AppUpdateModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React 上下文还没准备好" }

  override fun definition() = ModuleDefinition {
    Name("AppUpdate")

    /** 以系统记录的为准，不信构建配置：装上的是哪个包就是哪个版本。 */
    Function("currentVersion") {
      val info = context.packageManager.getPackageInfo(context.packageName, 0)
      val code =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode
        else @Suppress("DEPRECATION") info.versionCode.toLong()
      mapOf("code" to code.toDouble(), "name" to (info.versionName ?: ""))
    }

    /** 用户有没有允许这个 App 安装应用（“安装未知应用”）。 */
    Function("canRequestPackageInstalls") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) true
      else context.packageManager.canRequestPackageInstalls()
    }

    /** 直接打开这个 App 的“安装未知应用”开关页。 */
    Function("openInstallSettings") {
      val intent =
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }

    /**
     * 流式计算，不把几十 MB 的 APK 读进 JS 内存。AsyncFunction 不在主线程上跑。
     */
    AsyncFunction("sha256") { uri: String ->
      val path = Uri.parse(uri).path ?: throw IllegalArgumentException("不是文件地址")
      val digest = MessageDigest.getInstance("SHA-256")
      FileInputStream(File(path)).use { input ->
        val buffer = ByteArray(1 shl 16)
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          digest.update(buffer, 0, read)
        }
      }
      digest.digest().joinToString("") { "%02x".format(it) }
    }
  }
}
