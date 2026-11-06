package expo.modules.sharetargets

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.LinearLayout
import android.widget.TextView

/**
 * 只给 E2E 用的“聊天 App”：CI 的模拟器上没有微信、WhatsApp，连短信都不一定有。
 * 只有 E2E 构建的清单里有它（plugins/with-e2e-share-target.js），正式包里这个类用不到。
 * 收到什么文字就原样显示，Maestro 据此确认点按钮后整段文字确实发到了目标 App。
 */
class E2eShareTargetActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val text = intent?.takeIf { it.action == Intent.ACTION_SEND }?.getStringExtra(Intent.EXTRA_TEXT)
    val layout = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(48, 160, 48, 48)
    }
    layout.addView(TextView(this).apply { textSize = 20f; setText("E2E share target") })
    layout.addView(TextView(this).apply { textSize = 16f; setText(text ?: "") })
    setContentView(layout)
  }
}
