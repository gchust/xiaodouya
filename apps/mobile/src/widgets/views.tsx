import {
  formatClock,
  formatSyncedAt,
  formatVolume,
  shortBabyName,
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
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${formatClock(ms)}`;
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
    <Card link={null} label={`小豆芽，${message}`}>
      <TextWidget text="小豆芽" style={{ fontSize: 15, fontFamily: SERIF, color: c.ink }} />
      <TextWidget
        text={message}
        maxLines={3}
        style={{ fontSize: 12, color: c.inkSoft, lineHeight: 18 }}
      />
      <TextWidget text="点开 App ›" style={{ fontSize: 12, color: c.accent }} />
    </Card>
  );
}

type Ready = Extract<WidgetView, { kind: 'ready' }>;

function FeedCard({ view, newId, shown }: { view: Ready; newId: string; shown?: WidgetFeedback }) {
  const sync = formatSyncedAt(view.syncedAt, view.dayStart);
  const header = <Header title={shortBabyName(view.babyName, 11)} syncText={sync} dot={c.accent} />;
  if (shown) {
    return (
      <Card link={eventLink(shown.eventId)} label={`${shown.title}，点这里修改或撤销`}>
        {header}
        <Status title="记好了" detail="点这里修改或撤销" color={c.green} />
        <Button
          text={shown.title}
          background={c.green}
          color={c.white}
          link={eventLink(shown.eventId)}
          label={`${shown.title}，点这里修改或撤销`}
        />
      </Card>
    );
  }
  const { lastFeed } = view;
  const detail = lastFeed
    ? `${clockWithDay(lastFeed.at, view.dayStart)} · ${view.lastFeedAmount}`
    : '还没有喂奶记录';
  const link = lastFeed ? eventLink(lastFeed.id) : FEED_LINK;
  return (
    <Card link={link} label={`上次喂奶 ${detail}`}>
      {header}
      <Status title="上次喂奶" detail={detail} />
      {view.canQuickFeed && lastFeed ? (
        <Button
          text={`喂奶 ${formatVolume(lastFeed.ml, view.units.volume)}`}
          background={c.accent}
          color={c.white}
          action={{ type: 'feed', id: newId }}
          label={`记一次喂奶 ${formatVolume(lastFeed.ml, view.units.volume)}`}
        />
      ) : (
        <Button
          text="选奶量"
          background={c.accent}
          color={c.white}
          link={FEED_LINK}
          label="打开 App 选奶量"
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
      <Card link={eventLink(shown.eventId)} label={`${shown.title}，点这里修改或撤销`}>
        {header}
        <Status
          title={sleep.status === 'asleep' ? '睡觉中' : '醒了'}
          detail="点这里修改或撤销"
          color={c.sleep}
        />
        <Button
          text={shown.title}
          background={c.green}
          color={c.white}
          link={eventLink(shown.eventId)}
          label={`${shown.title}，点这里修改或撤销`}
        />
      </Card>
    );
  }
  if (sleep.status === 'asleep') {
    const detail = `${clockWithDay(sleep.since, view.dayStart)} 睡着`;
    return (
      <Card link={eventLink(sleep.id)} label={`睡觉中，${detail}`}>
        {header}
        <Status title="睡觉中" detail={detail} color={c.sleep} />
        <Button
          text="醒了"
          background={c.sleep}
          color={c.white}
          action={{ type: 'sleepEnd', sleepId: sleep.id }}
          label="记录醒了"
        />
      </Card>
    );
  }
  if (sleep.status === 'forgotten') {
    // 开着的睡眠超过 12 小时多半是忘了点“醒了”，不能显示成“睡觉中”，也不能一点就结束。
    const detail = `${clockWithDay(sleep.since, view.dayStart)} 开始，忘了点醒了？`;
    return (
      <Card link={eventLink(sleep.id)} label={`睡眠计时还开着，${detail}`}>
        {header}
        <Status title="计时还开着" detail={detail} />
        <Button
          text="去确认"
          background={c.ink}
          color={c.paper}
          link={eventLink(sleep.id)}
          label="到 App 里确认这次睡眠"
        />
      </Card>
    );
  }
  const detail = sleep.lastEnd
    ? `${clockWithDay(sleep.lastEnd, view.dayStart)} 醒来`
    : '还没有睡眠记录';
  return (
    <Card link={TODAY_LINK} label={`没在睡，${detail}`}>
      {header}
      <Status title="没在睡" detail={detail} />
      <Button
        text="开始睡觉"
        background={c.sand}
        color={c.ink}
        action={{ type: 'sleepStart', id: newId }}
        label="开始记录睡眠"
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
  const label = `${view.babyName} 今天，喂奶 ${today.feeds} 次 ${view.todayAmount}，尿布 ${today.diapers} 片，睡了 ${hours} 小时`;
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
          text={`${shortBabyName(view.babyName, 16)}的今天`}
          maxLines={1}
          truncate="END"
          style={{ fontSize: 15, fontFamily: SERIF, color: c.ink }}
        />
        <TextWidget
          // 系统定时刷新可能晚于 0 点，写明日期，显示的永远是这一天的真实数字。
          text={`${date.getMonth() + 1}月${date.getDate()}日 · ${formatSyncedAt(view.syncedAt, view.dayStart)}`}
          maxLines={1}
          style={{ fontSize: 10, color: c.muted, marginLeft: 6 }}
        />
      </FlexWidget>
      <FlexWidget style={{ width: 'match_parent', flexDirection: 'row' }}>
        <Stat
          color={c.accent}
          label="喂奶"
          value={`${today.feeds}`}
          unit={`次 · ${view.todayAmount}`}
        />
        <Stat color={c.diaper} label="尿布" value={`${today.diapers}`} unit="片" />
        <Stat color={c.sleep} label="睡眠" value={hours} unit="小时" />
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
