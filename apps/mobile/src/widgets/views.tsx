import {
  formatClock,
  formatShortDate,
  formatSyncedAt,
  formatVolume,
  shortBabyName,
  t,
  type WidgetAction,
  type WidgetView,
} from '@xiaodouya/shared';
import type { ReactElement } from 'react';
import { FlexWidget, TextWidget } from 'react-native-android-widget';
import { colors } from '../theme';
import { eventLink, FEED_LINK, TODAY_LINK } from './links';

export const widgetNames = ['FeedWidget', 'SleepWidget', 'SummaryWidget'] as const;
export type WidgetName = (typeof widgetNames)[number];

export interface WidgetFeedback {
  eventId: string;
  title: string;
}

type Hex = `#${string}`;
const c = colors as unknown as Record<keyof typeof colors, Hex>;

/** 字体由 app.config.ts 的插件复制进 APK，名字就是文件名（不带扩展名）。 */
const SERIF = 'NotoSerifSC-Bold.subset';
const MONO = 'DMMono-Medium';

const RECORD_ACTION = 'RECORD';

function clockWithDay(ms: number, dayStart: number): string {
  if (ms >= dayStart) return formatClock(ms);
  return `${formatShortDate(ms)} ${formatClock(ms)}`;
}

function Card({
  children,
  link,
  label,
}: {
  children: ReactElement | (ReactElement | null)[];
  link: string | null;
  label: string;
}) {
  return (
    <FlexWidget
      {...(link
        ? { clickAction: 'OPEN_URI', clickActionData: { uri: link } }
        : { clickAction: 'OPEN_APP' })}
      accessibilityLabel={label}
      style={{
        width: 'match_parent',
        height: 'match_parent',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundColor: c.card,
        borderColor: c.line,
        borderWidth: 1,
        borderRadius: 14,
        padding: 12,
      }}
    >
      {children}
    </FlexWidget>
  );
}

function Header({ title, syncText, dot }: { title: string; syncText: string; dot: Hex }) {
  return (
    <FlexWidget
      style={{
        width: 'match_parent',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      {/* 不用 flex：1，那样量出来的宽度偏大，会把同步时间挤出卡片。名字由调用方截短。 */}
      <FlexWidget style={{ flexDirection: 'row', alignItems: 'center' }}>
        <FlexWidget
          style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: dot, marginRight: 6 }}
        />
        <TextWidget
          text={title}
          maxLines={1}
          truncate="END"
          style={{ fontSize: 14, fontFamily: SERIF, color: c.ink }}
        />
      </FlexWidget>
      <TextWidget
        text={syncText}
        maxLines={1}
        style={{ fontSize: 10, color: c.muted, marginLeft: 6 }}
      />
    </FlexWidget>
  );
}

function Button({
  text,
  background,
  color,
  action,
  link,
  label,
}: {
  text: string;
  background: Hex;
  color: Hex;
  action?: WidgetAction;
  link?: string;
  label: string;
}) {
  const click = action
    ? { clickAction: RECORD_ACTION, clickActionData: action as Record<string, unknown> }
    : { clickAction: 'OPEN_URI', clickActionData: { uri: link ?? TODAY_LINK } };
  return (
    <FlexWidget
      {...click}
      accessibilityLabel={label}
      style={{
        width: 'match_parent',
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: background,
        borderRadius: 16,
      }}
    >
      <TextWidget text={text} maxLines={1} style={{ fontSize: 14, fontWeight: '700', color }} />
    </FlexWidget>
  );
}

function Status({ title, detail, color }: { title: string; detail: string; color?: Hex }) {
  return (
    <FlexWidget style={{ width: 'match_parent', flexDirection: 'column' }}>
      <TextWidget
        text={title}
        maxLines={1}
        truncate="END"
        style={{ fontSize: 18, fontFamily: SERIF, color: color ?? c.ink }}
      />
      <TextWidget
        text={detail}
        maxLines={1}
        truncate="END"
        style={{ fontSize: 11, color: c.muted, marginTop: 2 }}
      />
    </FlexWidget>
  );
}

/** 未登录、没有宝宝、只看回忆：不写数据也不显示记录，温和地请人点开 App。 */
function Blocked({ message }: { message: string }) {
  return (
    <Card link={null} label={t().widgetUi.a11yApp(message)}>
      <TextWidget
        text={t().common.appName}
        style={{ fontSize: 15, fontFamily: SERIF, color: c.ink }}
      />
      <TextWidget
        text={message}
        maxLines={3}
        style={{ fontSize: 12, color: c.inkSoft, lineHeight: 18 }}
      />
      <TextWidget text={t().widgetUi.openApp} style={{ fontSize: 12, color: c.accent }} />
    </Card>
  );
}

type Ready = Extract<WidgetView, { kind: 'ready' }>;

function FeedCard({ view, newId, shown }: { view: Ready; newId: string; shown?: WidgetFeedback }) {
  const sync = formatSyncedAt(view.syncedAt, view.dayStart);
  const header = <Header title={shortBabyName(view.babyName, 11)} syncText={sync} dot={c.accent} />;
  if (shown) {
    return (
      <Card link={eventLink(shown.eventId)} label={t().widgetUi.tapToEdit(shown.title)}>
        {header}
        <Status title={t().widgetUi.done} detail={t().widgetUi.tapHint} color={c.green} />
        <Button
          text={shown.title}
          background={c.green}
          color={c.white}
          link={eventLink(shown.eventId)}
          label={t().widgetUi.tapToEdit(shown.title)}
        />
      </Card>
    );
  }
  const { lastFeed } = view;
  const detail = lastFeed
    ? `${clockWithDay(lastFeed.at, view.dayStart)} · ${view.lastFeedAmount}`
    : t().widgetUi.noFeed;
  const link = lastFeed ? eventLink(lastFeed.id) : FEED_LINK;
  return (
    <Card link={link} label={t().widgetUi.lastFeedA11y(detail)}>
      {header}
      <Status title={t().widgetUi.lastFeed} detail={detail} />
      {view.canQuickFeed && lastFeed ? (
        <Button
          text={t().widgetUi.feedAmount(formatVolume(lastFeed.ml, view.units.volume))}
          background={c.accent}
          color={c.white}
          action={{ type: 'feed', id: newId }}
          label={t().widgetUi.logFeed(formatVolume(lastFeed.ml, view.units.volume))}
        />
      ) : (
        <Button
          text={t().widgetUi.pickAmount}
          background={c.accent}
          color={c.white}
          link={FEED_LINK}
          label={t().widgetUi.pickAmountA11y}
        />
      )}
    </Card>
  );
}

function SleepCard({ view, newId, shown }: { view: Ready; newId: string; shown?: WidgetFeedback }) {
  const sync = formatSyncedAt(view.syncedAt, view.dayStart);
  const { sleep } = view;
  const header = (
    <Header
      title={shortBabyName(view.babyName, 11)}
      syncText={sync}
      dot={sleep.status === 'awake' ? c.off : c.sleep}
    />
  );
  if (shown) {
    return (
      <Card link={eventLink(shown.eventId)} label={t().widgetUi.tapToEdit(shown.title)}>
        {header}
        <Status
          title={sleep.status === 'asleep' ? t().widgetUi.sleeping : t().widgetUi.awake}
          detail={t().widgetUi.tapHint}
          color={c.sleep}
        />
        <Button
          text={shown.title}
          background={c.green}
          color={c.white}
          link={eventLink(shown.eventId)}
          label={t().widgetUi.tapToEdit(shown.title)}
        />
      </Card>
    );
  }
  if (sleep.status === 'asleep') {
    const detail = t().widgetUi.fellAsleepAt(clockWithDay(sleep.since, view.dayStart));
    return (
      <Card link={eventLink(sleep.id)} label={t().widgetUi.sleepingA11y(detail)}>
        {header}
        <Status title={t().widgetUi.sleeping} detail={detail} color={c.sleep} />
        <Button
          text={t().widgetUi.awake}
          background={c.sleep}
          color={c.white}
          action={{ type: 'sleepEnd', sleepId: sleep.id }}
          label={t().widgetUi.logAwake}
        />
      </Card>
    );
  }
  if (sleep.status === 'forgotten') {
    // 开着的睡眠超过 12 小时多半是忘了点“醒了”，不能显示成“睡觉中”，也不能一点就结束。
    const detail = t().widgetUi.forgotWake(clockWithDay(sleep.since, view.dayStart));
    return (
      <Card link={eventLink(sleep.id)} label={t().widgetUi.timerOnA11y(detail)}>
        {header}
        <Status title={t().widgetUi.timerOn} detail={detail} />
        <Button
          text={t().widgetUi.confirm}
          background={c.ink}
          color={c.paper}
          link={eventLink(sleep.id)}
          label={t().widgetUi.confirmA11y}
        />
      </Card>
    );
  }
  const detail = sleep.lastEnd
    ? t().widgetUi.wokeAt(clockWithDay(sleep.lastEnd, view.dayStart))
    : t().widgetUi.noSleep;
  return (
    <Card link={TODAY_LINK} label={t().widgetUi.notAsleepA11y(detail)}>
      {header}
      <Status title={t().widgetUi.notAsleep} detail={detail} />
      <Button
        text={t().widgetUi.startSleep}
        background={c.sand}
        color={c.ink}
        action={{ type: 'sleepStart', id: newId }}
        label={t().widgetUi.startSleepA11y}
      />
    </Card>
  );
}

function Stat({
  color,
  label,
  value,
  unit,
}: {
  color: Hex;
  label: string;
  value: string;
  unit: string;
}) {
  return (
    <FlexWidget style={{ flex: 1, flexDirection: 'column' }}>
      <FlexWidget style={{ flexDirection: 'row', alignItems: 'center' }}>
        <FlexWidget
          style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color, marginRight: 5 }}
        />
        <TextWidget text={label} style={{ fontSize: 11, color: c.muted }} />
      </FlexWidget>
      <TextWidget
        text={value}
        maxLines={1}
        style={{ fontSize: 32, fontFamily: MONO, color: c.ink, marginTop: 2 }}
      />
      <TextWidget text={unit} maxLines={1} style={{ fontSize: 11, color: c.muted }} />
    </FlexWidget>
  );
}

function SummaryCard({ view }: { view: Ready }) {
  const { today } = view;
  const date = new Date(view.dayStart);
  const hours = (today.sleepMs / 3_600_000).toFixed(1);
  const label = t().widgetUi.todayA11y(
    view.babyName,
    today.feeds,
    view.todayAmount,
    today.diapers,
    hours,
  );
  return (
    <Card link={TODAY_LINK} label={label}>
      <FlexWidget
        style={{
          width: 'match_parent',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <TextWidget
          text={t().widgetUi.todayOf(shortBabyName(view.babyName, 16))}
          maxLines={1}
          truncate="END"
          style={{ fontSize: 15, fontFamily: SERIF, color: c.ink }}
        />
        <TextWidget
          // 系统定时刷新可能晚于 0 点，写明日期，显示的永远是这一天的真实数字。
          text={`${formatShortDate(date.getTime())} · ${formatSyncedAt(view.syncedAt, view.dayStart)}`}
          maxLines={1}
          style={{ fontSize: 10, color: c.muted, marginLeft: 6 }}
        />
      </FlexWidget>
      <FlexWidget style={{ width: 'match_parent', flexDirection: 'row' }}>
        <Stat
          color={c.accent}
          label={t().today.feed}
          value={`${today.feeds}`}
          unit={t().widgetUi.feedsUnit(today.feeds, view.todayAmount)}
        />
        <Stat
          color={c.diaper}
          label={t().today.diaper}
          value={`${today.diapers}`}
          unit={t().widgetUi.diapersUnit(today.diapers)}
        />
        <Stat color={c.sleep} label={t().today.sleep} value={hours} unit={t().widgetUi.hoursUnit} />
      </FlexWidget>
    </Card>
  );
}

export function renderWidgetFor(
  name: WidgetName,
  view: WidgetView,
  newId: string,
  shown?: WidgetFeedback,
): ReactElement {
  if (view.kind === 'blocked') return <Blocked message={view.message} />;
  switch (name) {
    case 'FeedWidget':
      return <FeedCard view={view} newId={newId} shown={shown} />;
    case 'SleepWidget':
      return <SleepCard view={view} newId={newId} shown={shown} />;
    case 'SummaryWidget':
      return <SummaryCard view={view} />;
  }
}
