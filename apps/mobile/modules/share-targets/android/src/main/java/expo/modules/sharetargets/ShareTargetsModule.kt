package expo.modules.sharetargets

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
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

  private fun query(intent: Intent) =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.packageManager.queryIntentActivities(intent, PackageManager.ResolveInfoFlags.of(0L))
    } else {
      @Suppress("DEPRECATION") context.packageManager.queryIntentActivities(intent, 0)
    }

  /**
   * 小豆芽自己也收文字分享（存成育儿资料，F-143），E2E 构建还多一个测试目标。
   * 发给自己的包时只写包名，系统会在这两个之间弹选择框；系统分享面板里也会列出小豆芽自己。
   */
  private fun ownReceivers(): List<ComponentName> =
    query(textIntent().setPackage(context.packageName)).map {
      ComponentName(it.activityInfo.packageName, it.activityInfo.name)
    }

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
      val intent = textIntent().putExtra(Intent.EXTRA_TEXT, text)
      if (packageName == context.packageName) {
        // 只有 E2E 构建会发给自己：直接指到测试 Activity。正式包里没有它，不能发给自己（会存成一条资料）。
        val e2e = ownReceivers().find { it.className == E2E_TARGET } ?: return@AsyncFunction false
        intent.component = e2e
      } else {
        intent.setPackage(packageName)
      }
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

    /**
     * “更多”：系统分享面板，去掉小豆芽自己（不然分享链接时能选到“存成育儿资料”）。
     * 打不开时返回 false，界面退回 React Native 的 Share。
     */
    AsyncFunction("shareSheet") { text: String ->
      val chooser = Intent.createChooser(textIntent().putExtra(Intent.EXTRA_TEXT, text), null)
      chooser.putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, ownReceivers().toTypedArray())
      val activity = appContext.currentActivity
      try {
        if (activity != null) {
          activity.startActivity(chooser)
        } else {
          context.startActivity(chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        true
      } catch (_: ActivityNotFoundException) {
        false
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("copyText") { text: String ->
      val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      clipboard.setPrimaryClip(ClipData.newPlainText(null, text))
    }.runOnQueue(Queues.MAIN)
  }
}

private const val E2E_TARGET = "expo.modules.sharetargets.E2eShareTargetActivity"
