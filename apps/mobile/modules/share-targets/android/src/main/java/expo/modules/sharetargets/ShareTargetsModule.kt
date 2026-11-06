package expo.modules.sharetargets

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.provider.Telephony
import android.util.Base64
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream

/**
 * 分享链接时直接发到某个聊天 App（F-139）。系统分享面板不能过滤，App 自己画一排常用的，
 * 名单和顺序在 packages/shared 的 regions/shareTargets.ts，这里只回答“装了什么”和“发过去”。
 *
 * Android 11 起看不到别的 App，清单里的 <queries> 只要了“能收文字分享的”，不要 QUERY_ALL_PACKAGES。
 */
class ShareTargetsModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React 上下文还没准备好" }

  private fun textIntent() = Intent(Intent.ACTION_SEND).setType("text/plain")

  override fun definition() = ModuleDefinition {
    Name("ShareTargets")

    Constant("packageName") { context.packageName }

    /** 能收文字分享的 App，每个包一条，名字是系统给的（跟着手机语言）。 */
    AsyncFunction("receivers") {
      val pm = context.packageManager
      val infos =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          pm.queryIntentActivities(textIntent(), PackageManager.ResolveInfoFlags.of(0L))
        } else {
          @Suppress("DEPRECATION") pm.queryIntentActivities(textIntent(), 0)
        }
      infos
        .map { it.activityInfo.applicationInfo }
        .distinctBy { it.packageName }
        .map { mapOf("packageName" to it.packageName, "label" to it.loadLabel(pm).toString()) }
    }

    /** 手机设置的默认短信 App。各家手机不一样（小米是 com.android.mms，三星是自己的），没有时是 null。 */
    Function("defaultSmsPackage") { Telephony.Sms.getDefaultSmsPackage(context) }

    /**
     * 系统画出来的应用图标，PNG 的 data URI。用的是这台手机上装着的图标，不打包别人的商标图片。
     * 取不到（刚被卸载）时是 null，界面用名字的首字代替。
     */
    AsyncFunction("icon") { packageName: String, size: Int ->
      try {
        val drawable = context.packageManager.getApplicationIcon(packageName)
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        drawable.setBounds(0, 0, size, size)
        drawable.draw(Canvas(bitmap))
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        bitmap.recycle()
        "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
      } catch (_: PackageManager.NameNotFoundException) {
        null
      }
    }

    /**
     * 只指定包名，不写死 Activity：微信、QQ 的分享入口类名会变，写死了换版本就打不开。
     * 一个 App 有好几个入口时（微信的“发送给朋友”和“添加到微信收藏”）系统只在这几个里让人选。
     * 打不开（刚卸载、被停用）时返回 false，界面提示用“更多”。
     */
    AsyncFunction("sendText") { packageName: String, text: String ->
      val intent = textIntent().putExtra(Intent.EXTRA_TEXT, text).setPackage(packageName)
      val activity = appContext.currentActivity
      try {
        if (activity != null) {
          activity.startActivity(intent)
        } else {
          context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        true
      } catch (_: ActivityNotFoundException) {
        false
      } catch (_: SecurityException) {
        false
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("copyText") { text: String ->
      val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      clipboard.setPrimaryClip(ClipData.newPlainText(null, text))
    }.runOnQueue(Queues.MAIN)
  }
}
