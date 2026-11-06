package expo.modules.shareintent

import android.content.Intent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * 从别的 App 分享过来的一段文字（ACTION_SEND，text/*），用来存育儿资料（issue #98）。
 * 清单里的 intent-filter 写在 app.config.ts。只收文字，不收文件。
 *
 * 取过一次就清掉：Activity 重建时 getIntent() 还是那个分享的 Intent，不清的话每次都会再弹一次。
 */
class ShareIntentModule : Module() {
  /** App 开着时分享过来的（onNewIntent）。这时 MainActivity 还没 setIntent，先存在这里。 */
  @Volatile private var pending: Map<String, String?>? = null

  override fun definition() = ModuleDefinition {
    Name("ShareIntent")
    Events("onShare")

    Function("take") {
      val fromNewIntent = pending
      pending = null
      val activity = appContext.currentActivity
      val current = activity?.intent
      val fromLaunch = current?.let { read(it) }
      if (activity != null && current != null && fromLaunch != null) {
        activity.intent = Intent(current).apply {
          action = Intent.ACTION_MAIN
          removeExtra(Intent.EXTRA_TEXT)
          removeExtra(Intent.EXTRA_SUBJECT)
        }
      }
      fromNewIntent ?: fromLaunch
    }

    OnNewIntent { intent ->
      val shared = read(intent) ?: return@OnNewIntent
      pending = shared
      sendEvent("onShare", emptyMap<String, Any>())
    }
  }

  private fun read(intent: Intent): Map<String, String?>? {
    if (intent.action != Intent.ACTION_SEND) return null
    if (intent.type?.startsWith("text/") != true) return null
    val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
    if (text.isNullOrBlank()) return null
    val subject = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.toString()
    // 只是为了挡住异常大的输入，正常的分享文字几百个字
    return mapOf("text" to text.take(10_000), "subject" to subject?.take(500))
  }
}
