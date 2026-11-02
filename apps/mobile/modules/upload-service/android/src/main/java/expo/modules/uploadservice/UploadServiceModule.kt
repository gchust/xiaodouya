package expo.modules.uploadservice

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class NoticeRecord : Record {
  @Field var channelName: String = ""
  @Field var title: String = ""
  @Field var text: String? = null
  @Field var percent: Int? = null
  @Field var cancelLabel: String = ""
  @Field var pausedTitle: String = ""
  @Field var detailsLink: String = ""
  @Field var cancelLink: String = ""

  fun toNotice() =
    UploadNotice(channelName, title, text, percent, cancelLabel, detailsLink, cancelLink)
}

/**
 * JS 队列和前台服务之间的薄层。何时启停由 JS 决定（uploadServicePolicy），这里只做。
 *
 * 保活任务：RN 的定时器在 App 暂停后不走（JavaTimerManager），只有 Headless JS 任务在跑时例外。
 * fetch 是 whatwg-fetch，完成后要 setTimeout(0) 才 resolve，所以没有它的话后台第一个请求就永远等不到结果。
 */
class UploadServiceModule : Module() {
  private var keepAliveTask: Int? = null

  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React 上下文还没准备好" }

  override fun definition() = ModuleDefinition {
    Name("UploadService")

    Events("onServiceEvent")

    OnCreate {
      UploadService.listener = { event ->
        sendEvent("onServiceEvent", mapOf("type" to event))
      }
    }

    OnDestroy {
      UploadService.listener = null
    }

    /** 返回 false 表示系统不让启动（比如 App 在后台），上传只好等 App 回到前台。 */
    Function("start") { notice: NoticeRecord ->
      UploadService.pausedTitle = notice.pausedTitle
      UploadService.current = notice.toNotice()
      UploadService.clearPaused(context)
      UploadService.stopRequested = false
      if (UploadService.running) {
        UploadService.update(context, notice.toNotice())
        return@Function true
      }
      try {
        ContextCompat.startForegroundService(context, Intent(context, UploadService::class.java))
        UploadService.running = true
        startKeepAlive()
        true
      } catch (_: IllegalStateException) {
        // ForegroundServiceStartNotAllowedException 是它的子类，这个类 API 31 才有。
        UploadService.running = false
        UploadService.current = null
        false
      } catch (_: SecurityException) {
        UploadService.running = false
        UploadService.current = null
        false
      }
    }

    Function("update") { notice: NoticeRecord ->
      UploadService.pausedTitle = notice.pausedTitle
      if (UploadService.running) UploadService.update(context, notice.toNotice())
    }

    Function("stop") {
      stopKeepAlive()
      val wasRunning = UploadService.running
      UploadService.running = false
      val appContext = context
      // 服务的回调都在主线程，这里也放到主线程，foregrounded 的判断才不会和 onStartCommand 抢。
      UiThreadUtil.runOnUiThread {
        if (!wasRunning) return@runOnUiThread
        if (UploadService.foregrounded) {
          UploadService.current = null
          appContext.stopService(Intent(appContext, UploadService::class.java))
        } else if (!UploadService.running) {
          UploadService.stopRequested = true
        }
      }
    }

    Function("isRunning") { UploadService.running }

    /** JS 收到 timeout 事件后调用：服务已经停了，定时器也不用再保活。 */
    Function("releaseKeepAlive") { stopKeepAlive() }
  }

  /** HeadlessJsTaskContext 要求在主线程调用。keepAliveTask 也只在主线程碰。 */
  private fun startKeepAlive() {
    val react = appContext.reactContext as? ReactContext ?: return
    UiThreadUtil.runOnUiThread {
      if (keepAliveTask != null) return@runOnUiThread
      // allowedInForeground：App 在前台时也要先把任务起好，用户按 Home 之后就来不及了。
      val config = HeadlessJsTaskConfig(KEEP_ALIVE_TASK, Arguments.createMap(), 0, true)
      try {
        keepAliveTask = HeadlessJsTaskContext.getInstance(react).startTask(config)
      } catch (_: IllegalStateException) {
        keepAliveTask = null
      }
    }
  }

  private fun stopKeepAlive() {
    val react = appContext.reactContext as? ReactContext ?: return
    UiThreadUtil.runOnUiThread {
      val task = keepAliveTask ?: return@runOnUiThread
      keepAliveTask = null
      val tasks = HeadlessJsTaskContext.getInstance(react)
      if (tasks.isTaskRunning(task)) tasks.finishTask(task)
    }
  }

  companion object {
    private const val KEEP_ALIVE_TASK = "XiaodouyaUploadKeepAlive"
  }
}
