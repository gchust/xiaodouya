package expo.modules.uploadservice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/** 通知上显示的内容。文字都由 JS 给，这样跟随 App 的语言。 */
data class UploadNotice(
  val channelName: String,
  val title: String,
  val text: String?,
  val percent: Int?,
  val cancelLabel: String,
  val detailsLink: String,
  val cancelLink: String,
)

/**
 * 有上传任务时让进程活着。上传还是 JS 队列在做，这里不碰文件和网络：
 * 前台服务保活，部分唤醒锁让锁屏后 CPU 继续跑，Wi-Fi 锁让锁屏后 Wi-Fi 不降速。
 */
class UploadService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    val power = getSystemService(Context.POWER_SERVICE) as PowerManager
    // 超时是兜底：JS 出问题没来得及停服务时，不能一直耗电。系统的上限也是 6 小时。
    wakeLock =
      power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "xiaodouya:upload").apply {
        setReferenceCounted(false)
        acquire(WAKE_LOCK_TIMEOUT_MS)
      }
    val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    @Suppress("DEPRECATION")
    wifiLock =
      wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "xiaodouya:upload").apply {
        setReferenceCounted(false)
        acquire()
      }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notice = current
    if (notice == null) {
      // 系统重启服务时进程是新的，JS 还不知道这件事。这个分支照样要先进入前台，否则系统直接崩掉 App。
      val fallback = fallbackNotice()
      enterForeground(build(this, fallback))
      stopNow()
      return START_NOT_STICKY
    }
    enterForeground(build(this, notice))
    foregrounded = true
    // 小文件可能在系统回调这里之前就传完了。没进前台就 stopService 的话，系统会以
    // “did not then call startForeground” 崩掉 App，所以先进前台，再停。
    if (stopRequested) {
      stopRequested = false
      stopNow()
    }
    return START_NOT_STICKY
  }

  private fun enterForeground(notification: Notification) {
    ServiceCompat.startForeground(
      this,
      NOTIFICATION_ID,
      notification,
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
      } else {
        0
      },
    )
  }

  /** 用户从最近任务划掉。stopWithTask=false 时服务不停，这里只记一下，方便排查。 */
  override fun onTaskRemoved(rootIntent: Intent?) {
    super.onTaskRemoved(rootIntent)
    listener?.invoke("taskRemoved")
  }

  /**
   * Android 15 起 dataSync 前台服务 24 小时内最多跑 6 小时（用户回到 App 后重新计时）。
   * 到了只有几秒必须停，否则系统抛 RemoteServiceException。任务都留在队列里，下次打开接着传。
   */
  override fun onTimeout(startId: Int, fgsType: Int) {
    super.onTimeout(startId, fgsType)
    val notice = current
    listener?.invoke("timeout")
    stopNow()
    if (notice != null) postPaused(notice)
  }

  private fun stopNow() {
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
    running = false
    foregrounded = false
    current = null
  }

  private fun postPaused(notice: UploadNotice) {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.notify(
      PAUSED_NOTIFICATION_ID,
      NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.stat_sys_upload)
        .setContentTitle(pausedTitle ?: notice.title)
        .setContentIntent(linkIntent(this, notice.detailsLink, REQUEST_DETAILS))
        .setAutoCancel(true)
        .build(),
    )
  }

  private fun fallbackNotice() =
    UploadNotice(
      channelName = "Uploads",
      title = "Uploading",
      text = null,
      percent = null,
      cancelLabel = "Cancel all",
      detailsLink = "",
      cancelLink = "",
    )

  override fun onDestroy() {
    if (wakeLock?.isHeld == true) wakeLock?.release()
    if (wifiLock?.isHeld == true) wifiLock?.release()
    wakeLock = null
    wifiLock = null
    running = false
    foregrounded = false
    super.onDestroy()
  }

  companion object {
    private const val CHANNEL_ID = "uploads"
    private const val NOTIFICATION_ID = 7301
    private const val PAUSED_NOTIFICATION_ID = 7302
    private const val REQUEST_DETAILS = 1
    private const val REQUEST_CANCEL = 2
    private const val WAKE_LOCK_TIMEOUT_MS = 6 * 60 * 60 * 1000L

    @Volatile var running = false
    @Volatile var foregrounded = false
    @Volatile var stopRequested = false
    @Volatile var current: UploadNotice? = null
    @Volatile var pausedTitle: String? = null
    @Volatile var listener: ((String) -> Unit)? = null

    private fun linkIntent(context: Context, link: String, request: Int): PendingIntent {
      val intent =
        Intent(Intent.ACTION_VIEW, Uri.parse(link)).apply {
          setPackage(context.packageName)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
      return PendingIntent.getActivity(
        context,
        request,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    private fun ensureChannel(context: Context, name: String) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      // LOW：进度每秒变，不能响也不能震。
      val channel = NotificationChannel(CHANNEL_ID, name, NotificationManager.IMPORTANCE_LOW)
      channel.setShowBadge(false)
      manager.createNotificationChannel(channel)
    }

    fun build(context: Context, notice: UploadNotice): Notification {
      ensureChannel(context, notice.channelName)
      val builder =
        NotificationCompat.Builder(context, CHANNEL_ID)
          .setSmallIcon(android.R.drawable.stat_sys_upload)
          .setContentTitle(notice.title)
          .setContentText(notice.text)
          .setOngoing(true)
          .setOnlyAlertOnce(true)
          .setSilent(true)
          .setCategory(NotificationCompat.CATEGORY_PROGRESS)
          .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      if (notice.percent == null) {
        builder.setProgress(0, 0, true)
      } else {
        builder.setProgress(100, notice.percent, false)
      }
      if (notice.detailsLink.isNotEmpty()) {
        builder.setContentIntent(linkIntent(context, notice.detailsLink, REQUEST_DETAILS))
      }
      if (notice.cancelLink.isNotEmpty()) {
        // 取消要确认，所以按钮是打开 App 的确认弹层，不是直接删。
        builder.addAction(0, notice.cancelLabel, linkIntent(context, notice.cancelLink, REQUEST_CANCEL))
      }
      return builder.build()
    }

    fun update(context: Context, notice: UploadNotice) {
      current = notice
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      manager.notify(NOTIFICATION_ID, build(context, notice))
    }

    fun clearPaused(context: Context) {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      manager.cancel(PAUSED_NOTIFICATION_ID)
    }
  }
}
