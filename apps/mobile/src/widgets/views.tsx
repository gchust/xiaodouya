import {
  type DiaperKind,
  formatClock,
  formatShortDate,
  formatSyncedAt,
  shortBabyName,
  t,
  type WidgetAction,
  type WidgetView,
} from '@xiaodouya/shared';
import type { ReactElement } from 'react';
import { FlexWidget, ImageWidget, SvgWidget, TextWidget } from 'react-native-android-widget';
import { DAYLINE_HEIGHT, daylineSvg } from './dayline';
import { eventLink, FEED_LINK, TODAY_LINK } from './links';
import { type WidgetPalette, widgetPalettes } from './palette';
import { buttonOf } from './pending';

export const widgetNames = [
  'FeedWidget',
  'SleepWidget',
  'SummaryWidget',
  'DiaperWidget',
  'QuickWidget',
] as const;
export type WidgetName = (typeof widgetNames)[number];

/** 小工具上能直接记录的按钮。快捷记录上一次显示五个，刚记好时要知道变绿的是哪一个。 */
export type WidgetButton = 'feed' | 'sleep' | DiaperKind;

export { buttonOf };

/** 每个按钮一个新 id：同一张画面上连点同一个按钮仍然是同一条记录，点不同的按钮各记各的。 */
export type WidgetIds = Record<WidgetButton, string>;

export interface WidgetFeedback {
  eventId: string;
  title: string;
  at: number;
  button: WidgetButton;
}

export interface WidgetSize {
  width: number;
  height: number;
}

type Hex = `#${string}`;

/** 缓存好的头像（`avatarCache.ts`）。只能是本机文件读出来的 data URI，小工具里不联网。 */
export type WidgetAvatarUri = `data:image/${string}`;
/** 头像只在 App 里有：shared 的 `WidgetView` 不碰文件。没有头像时和原来一样。 */
export type ShownWidgetView = WidgetView & { avatar?: WidgetAvatarUri };
type Ready = Extract<WidgetView, { kind: 'ready' }> & { avatar?: WidgetAvatarUri };

/** 2×2 的上排和色点换成小头像；4×2 的标题前面放大一号的。 */
const AVATAR_SMALL = 16;
const AVATAR_WIDE = 22;

/** 字体由 app.config.ts 的插件复制进 APK，名字就是文件名（不带扩展名）。只有这两个字重。 */
const SERIF = 'NotoSerifSC-Bold.subset';
const MONO = 'DMMono-Medium';
const RECORD_ACTION = 'RECORD';
const PADDING_X = 14;

function click(action?: WidgetAction, link?: string) {
  return action
    ? { clickAction: RECORD_ACTION, clickActionData: action as Record<string, unknown> }
    : { clickAction: 'OPEN_URI', clickActionData: { uri: link ?? TODAY_LINK } };
}

/** 不是今天的钟点前面带上日期，不然昨晚 23:40 会被看成今天的。 */
function clockOn(ms: number, dayStart: number): string {
  return ms >= dayStart ? formatClock(ms) : `${formatShortDate(ms)} ${formatClock(ms)}`;
}

const diaperLabel = (kind: DiaperKind) =>
  kind === 'wee'
    ? t().records.diaperWet
    : kind === 'poo'
      ? t().records.diaperDirty
      : t().records.diaperBoth;

const sleptHours = (view: Ready) => (view.today.sleepMs / 3_600_000).toFixed(1);

function Card({
  children,
  link,
  label,
  background,
}: {
  children: (ReactElement | null)[];
  link: string | null;
  label: string;
  background: Hex;
}) {
  return (
    <FlexWidget
      {...(link ? click(undefined, link) : { clickAction: 'OPEN_APP' })}
      accessibilityLabel={label}
      style={{
        width: 'match_parent',
        height: 'match_parent',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundColor: background,
        borderRadius: 20,
        paddingHorizontal: PADDING_X,
        paddingTop: 13,
        paddingBottom: 12,
      }}
    >
      {children}
    </FlexWidget>
  );
}

function Dot({ color, size = 7, gap = 6 }: { color: Hex; size?: number; gap?: number }) {
  return (
    <FlexWidget
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        marginRight: gap,
      }}
    />
  );
}

/** 圆形头像。原生先把图拉成 size×size 再画，缓存里已经裁成正方形，所以不会变形。 */
function Avatar({ uri, size, gap }: { uri: WidgetAvatarUri; size: number; gap: number }) {
  return (
    <ImageWidget
      image={uri}
      imageWidth={size}
      imageHeight={size}
      radius={size / 2}
      style={{ marginRight: gap }}
    />
  );
}

/** 同步时间平时不显示；旧了才出现，提醒家人的记录可能还没到（见 `WIDGET_SYNC_STALE_MS`）。 */
function SyncPill({ view, p }: { view: Ready; p: WidgetPalette }) {
  return (
    <FlexWidget
      style={{
        backgroundColor: p.staleBg,
        borderRadius: 8,
        paddingHorizontal: 7,
        paddingVertical: 1,
      }}
    >
      <TextWidget
        text={formatSyncedAt(view.syncedAt, view.dayStart)}
        maxLines={1}
        style={{ fontSize: 10, color: p.staleText }}
      />
    </FlexWidget>
  );
}

function Header({
  view,
  p,
  dot,
  ink,
  right,
}: {
  view: Ready;
  p: WidgetPalette;
  dot: Hex;
  ink: Hex;
  right?: ReactElement | null;
}) {
  return (
    <FlexWidget
      style={{
        width: 'match_parent',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      {/* 不用 flex：1，那样量出来的宽度偏大，会把右边挤出卡片。名字在这里截短。 */}
      {/* 头像比色点宽 10dp 左右，名字少放两格（约一个汉字）。 */}
      <FlexWidget style={{ flexDirection: 'row', alignItems: 'center' }}>
        {view.avatar ? (
          <Avatar uri={view.avatar} size={AVATAR_SMALL} gap={6} />
        ) : (
          <Dot color={dot} />
        )}
        <TextWidget
          text={shortBabyName(view.babyName, (view.showSync ? 8 : 14) - (view.avatar ? 2 : 0))}
          maxLines={1}
          style={{ fontSize: 12, fontWeight: '700', color: ink }}
        />
      </FlexWidget>
      {view.showSync ? <SyncPill view={view} p={p} /> : (right ?? null)}
    </FlexWidget>
  );
}

/** 数字是主角：上面一行小字说这是什么，中间是等宽的大钟点，下面一行补充。 */
function Hero({
  label,
  time,
  sub,
  ink,
  muted,
  labelColor,
  subColor,
}: {
  label: string;
  time: string;
  sub?: string;
  ink: Hex;
  muted: Hex;
  labelColor?: Hex;
  subColor?: Hex;
}) {
  return (
    <FlexWidget style={{ width: 'match_parent', flexDirection: 'column' }}>
      <TextWidget
        text={label}
        maxLines={1}
        truncate="END"
        style={{ fontSize: 11, color: labelColor ?? muted }}
      />
      <TextWidget text={time} maxLines={1} style={{ fontSize: 34, fontFamily: MONO, color: ink }} />
      {sub ? (
        <TextWidget
          text={sub}
          maxLines={1}
          truncate="END"
          style={{ fontSize: 12, color: subColor ?? muted }}
        />
      ) : null}
    </FlexWidget>
  );
}

/** 还没有记录时没有钟点可放，用一句衬线标题代替。 */
function Empty({ title, sub, ink, muted }: { title: string; sub: string; ink: Hex; muted: Hex }) {
  return (
    <FlexWidget style={{ width: 'match_parent', flexDirection: 'column' }}>
      <TextWidget
        text={title}
        maxLines={2}
        style={{ fontSize: 16, fontFamily: SERIF, color: ink }}
      />
      <TextWidget text={sub} maxLines={2} style={{ fontSize: 12, color: muted, marginTop: 2 }} />
    </FlexWidget>
  );
}

/** 被点的按钮在写好之前换成“记录中…”，点击仍是原来那一次，见 `pending.ts`。 */
const isPending = (action?: WidgetAction, pending?: WidgetButton) =>
  Boolean(action && pending && buttonOf(action) === pending);

function Button({
  text,
  background,
  color,
  action,
  link,
  label,
  pending,
}: {
  text: string;
  background: Hex;
  color: Hex;
  action?: WidgetAction;
  link?: string;
  label: string;
  pending?: WidgetButton;
}) {
  const shownText = isPending(action, pending) ? t().widgetUi.recording : text;
  return (
    <FlexWidget
      {...click(action, link)}
      accessibilityLabel={label}
      style={{
        width: 'match_parent',
        height: 38,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: background,
        borderRadius: 19,
      }}
    >
      <TextWidget
        text={shownText}
        maxLines={1}
        style={{ fontSize: 14, fontWeight: '700', color }}
      />
    </FlexWidget>
  );
}

/** 方形的小按钮：尿布三个，快捷记录五个。上面一个色点或一行小字，下面是字。 */
function Chip({
  top,
  text,
  background,
  color,
  action,
  link,
  label,
  flex = 1,
  mono,
  pending,
}: {
  top: ReactElement;
  text: string;
  background: Hex;
  color: Hex;
  action?: WidgetAction;
  link?: string;
  label: string;
  flex?: number;
  mono?: boolean;
  pending?: WidgetButton;
}) {
  const busy = isPending(action, pending);
  return (
    <FlexWidget
      {...click(action, link)}
      accessibilityLabel={label}
      style={{
        flex,
        height: 46,
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: background,
        borderRadius: 14,
      }}
    >
      {top}
      <TextWidget
        text={busy ? t().widgetUi.recording : text}
        maxLines={1}
        style={{
          fontSize: mono && !busy ? 15 : 13,
          fontWeight: '700',
          color,
          marginTop: 4,
          ...(mono && !busy ? { fontFamily: MONO } : {}),
        }}
      />
    </FlexWidget>
  );
}

function SmallText({ text, color }: { text: string; color: Hex }) {
  return <TextWidget text={text} maxLines={1} style={{ fontSize: 11, fontWeight: '600', color }} />;
}

/** 直接调用拿到数组，不当成组件用：小工具的渲染只认一层层的元素，组件不能返回数组。 */
function diaperChips(
  p: WidgetPalette,
  ids: WidgetIds,
  shown?: WidgetFeedback,
  pending?: WidgetButton,
): ReactElement[] {
  const kinds: { kind: DiaperKind; dot: Hex }[] = [
    { kind: 'wee', dot: p.wee },
    { kind: 'poo', dot: p.poo },
    { kind: 'both', dot: p.diaperDot },
  ];
  return kinds.map(({ kind, dot }) =>
    shown?.button === kind ? (
      <Chip
        key={kind}
        top={<SmallText text={t().widgetUi.chipDone} color={p.white} />}
        text={t().widgetUi.chipEdit}
        background={p.okButton}
        color={p.white}
        link={eventLink(shown.eventId)}
        label={t().widgetUi.tapToEdit(shown.title)}
      />
    ) : (
      <Chip
        key={kind}
        top={<Dot color={dot} gap={0} />}
        text={diaperLabel(kind)}
        background={p.chip}
        color={p.chipText}
        action={{ type: 'diaper', id: ids[kind], kind }}
        label={t().widgetUi.logDiaper(diaperLabel(kind))}
        pending={pending}
      />
    ),
  );
}

function Row({ children, gap = 6 }: { children: ReactElement[]; gap?: number }) {
  return (
    <FlexWidget style={{ width: 'match_parent', flexDirection: 'row', flexGap: gap }}>
      {children}
    </FlexWidget>
  );
}

interface CardProps {
  view: Ready;
  p: WidgetPalette;
  ids: WidgetIds;
  shown?: WidgetFeedback;
  size: WidgetSize;
  pending?: WidgetButton;
}

function nextFeedLine(view: Ready, p: WidgetPalette): { text: string; color?: Hex } | null {
  const next = view.nextFeed;
  if (!next) return null;
  if (next.status === 'due') return { text: t().today.feedDue, color: p.accentText };
  const text = t().widgetUi.nextFeedAt(formatClock(next.at));
  return next.status === 'near' ? { text, color: p.accentText } : { text };
}

/**
 * 正在亲喂或者忘了关时，记喂奶小工具整张换成计时（issue #104）。不能走字，只写开始的钟点；
 * 点卡片打开 App 的喂奶弹层，那里能换边。忘了关的不能一点就结束，和睡眠一样去 App 里确认。
 */
function BreastTimerCard({ view, p, pending }: Pick<CardProps, 'view' | 'p' | 'pending'>) {
  const { breast } = view;
  if (breast.status === 'forgotten') {
    const since = breast.since >= view.dayStart ? '' : formatShortDate(breast.since);
    return (
      <Card background={p.card} link={FEED_LINK} label={t().widgetUi.breastConfirmA11y}>
        <Header view={view} p={p} dot={p.feedDot} ink={p.ink} />
        <Hero
          label={t().widgetUi.breastForgottenSince(since)}
          labelColor={p.accentText}
          time={formatClock(breast.since)}
          sub={t().widgetUi.over2h}
          ink={p.ink}
          muted={p.muted}
        />
        <Button
          text={t().widgetUi.breastConfirm}
          background={p.confirmButton}
          color={p.confirmText}
          link={FEED_LINK}
          label={t().widgetUi.breastConfirmA11y}
        />
      </Card>
    );
  }
  if (breast.status !== 'running') return null;
  return (
    <Card
      background={p.card}
      link={FEED_LINK}
      label={t().widgetUi.breastRunningA11y(t().widgetUi.breastRunningSub(breast.side))}
    >
      <Header view={view} p={p} dot={p.feedDot} ink={p.ink} />
      <Hero
        label={t().widgetUi.breastRunningSince}
        labelColor={p.accentText}
        time={formatClock(breast.since)}
        sub={t().widgetUi.breastRunningSub(breast.side)}
        ink={p.ink}
        muted={p.muted}
      />
      <Button
        text={t().widgetUi.breastEnd}
        background={p.accent}
        color={p.white}
        action={{ type: 'breastEnd', feedId: breast.id }}
        pending={pending}
        label={t().widgetUi.breastEndA11y}
      />
    </Card>
  );
}

function FeedCard({ view, p, ids, shown, pending }: CardProps) {
  const { lastFeed, lastFeedAmount, breast } = view;
  if (!shown && (breast.status === 'running' || breast.status === 'forgotten')) {
    return <BreastTimerCard view={view} p={p} pending={pending} />;
  }
  if (shown) {
    return (
      <Card
        background={p.card}
        link={eventLink(shown.eventId)}
        label={t().widgetUi.tapToEdit(shown.title)}
      >
        <Header view={view} p={p} dot={p.okDot} ink={p.ink} />
        <Hero
          label={t().widgetUi.logged(shown.title)}
          labelColor={p.okText}
          time={formatClock(shown.at)}
          sub={t().widgetUi.fixHint}
          ink={p.ink}
          muted={p.muted}
        />
        <Button
          text={t().widgetUi.editOrUndo}
          background={p.okButton}
          color={p.white}
          link={eventLink(shown.eventId)}
          label={t().widgetUi.tapToEdit(shown.title)}
        />
      </Card>
    );
  }
  if (!lastFeed || !lastFeedAmount) {
    return (
      <Card background={p.card} link={FEED_LINK} label={t().widgetUi.pickAmountA11y}>
        <Header view={view} p={p} dot={p.feedDot} ink={p.ink} />
        <Empty
          title={t().widgetUi.noFeed}
          sub={t().widgetUi.noFeedHint}
          ink={p.ink}
          muted={p.muted}
        />
        <Button
          text={t().widgetUi.pickAmount}
          background={p.accent}
          color={p.white}
          link={FEED_LINK}
          label={t().widgetUi.pickAmountA11y}
        />
      </Card>
    );
  }
  const label =
    lastFeed.at >= view.dayStart
      ? t().widgetUi.withAmount(t().widgetUi.lastFeed, lastFeedAmount)
      : t().widgetUi.withAmount(
          t().widgetUi.lastFeedOn(formatShortDate(lastFeed.at)),
          lastFeedAmount,
        );
  const next = nextFeedLine(view, p);
  // 上一次是亲喂：按钮从另一侧开始计时；点卡片打开喂奶弹层，那里也能改成瓶喂。
  const nextSide = breast.status === 'next' ? breast.side : null;
  return (
    <Card
      background={p.card}
      link={nextSide ? FEED_LINK : eventLink(lastFeed.id)}
      label={t().widgetUi.lastFeedA11y(
        `${clockOn(lastFeed.at, view.dayStart)} · ${lastFeedAmount}`,
      )}
    >
      <Header view={view} p={p} dot={p.feedDot} ink={p.ink} />
      <Hero
        label={label}
        time={formatClock(lastFeed.at)}
        sub={next?.text}
        subColor={next?.color}
        ink={p.ink}
        muted={p.muted}
      />
      {nextSide ? (
        <Button
          text={t().widgetUi.breastStart(nextSide)}
          background={p.accent}
          color={p.white}
          action={{ type: 'breastStart', id: ids.feed, side: nextSide }}
          pending={pending}
          label={t().widgetUi.breastStartA11y(nextSide)}
        />
      ) : view.quickFeedAmount ? (
        <Button
          text={t().widgetUi.plusAmount(view.quickFeedAmount)}
          background={p.accent}
          color={p.white}
          action={{ type: 'feed', id: ids.feed }}
          pending={pending}
          label={t().widgetUi.logFeed(view.quickFeedAmount)}
        />
      ) : (
        <Button
          text={t().widgetUi.pickAmount}
          background={p.accent}
          color={p.white}
          link={FEED_LINK}
          label={t().widgetUi.pickAmountA11y}
        />
      )}
    </Card>
  );
}

function SleepCard({ view, p, ids, shown, pending }: CardProps) {
  const { sleep } = view;
  const slept = t().widgetUi.sleptToday(sleptHours(view));
  // 睡着时整块变成夜蓝色，远远一看就知道宝宝在不在睡。
  if (sleep.status === 'asleep') {
    const edit = shown ? eventLink(shown.eventId) : eventLink(sleep.id);
    return (
      <Card
        background={p.nightCard}
        link={edit}
        label={t().widgetUi.sleepingA11y(t().widgetUi.fellAsleepAt(formatClock(sleep.since)))}
      >
        <Header view={view} p={p} dot={p.nightDot} ink={p.nightInk} />
        <Hero
          label={shown ? t().widgetUi.logged(shown.title) : t().widgetUi.asleepSince}
          labelColor={shown ? p.nightInk : p.nightMuted}
          time={formatClock(sleep.since)}
          sub={shown ? t().widgetUi.fixHint : slept}
          ink={p.nightInk}
          muted={p.nightMuted}
        />
        {shown ? (
          <Button
            text={t().widgetUi.editOrUndo}
            background={p.okButton}
            color={p.white}
            link={edit}
            label={t().widgetUi.tapToEdit(shown.title)}
          />
        ) : (
          <Button
            text={t().widgetUi.awake}
            background={p.nightButton}
            color={p.nightButtonText}
            action={{ type: 'sleepEnd', sleepId: sleep.id }}
            pending={pending}
            label={t().widgetUi.logAwake}
          />
        )}
      </Card>
    );
  }
  if (sleep.status === 'forgotten') {
    // 开着的睡眠超过 12 小时多半是忘了点“醒了”，不能显示成“睡着了”，也不能一点就结束。
    const since = sleep.since >= view.dayStart ? '' : formatShortDate(sleep.since);
    return (
      <Card
        background={p.card}
        link={eventLink(sleep.id)}
        label={t().widgetUi.timerOnA11y(clockOn(sleep.since, view.dayStart))}
      >
        <Header view={view} p={p} dot={p.sleepDot} ink={p.ink} />
        <Hero
          label={t().widgetUi.timerOnSince(since)}
          time={formatClock(sleep.since)}
          sub={t().widgetUi.over12h}
          ink={p.ink}
          muted={p.muted}
        />
        <Button
          text={t().widgetUi.confirmWake}
          background={p.confirmButton}
          color={p.confirmText}
          link={eventLink(sleep.id)}
          label={t().widgetUi.confirmA11y}
        />
      </Card>
    );
  }
  const start = (
    <Button
      text={t().widgetUi.fellAsleep}
      background={p.sleepButton}
      color={p.white}
      action={{ type: 'sleepStart', id: ids.sleep }}
      pending={pending}
      label={t().widgetUi.startSleepA11y}
    />
  );
  if (shown) {
    return (
      <Card
        background={p.card}
        link={eventLink(shown.eventId)}
        label={t().widgetUi.tapToEdit(shown.title)}
      >
        <Header view={view} p={p} dot={p.okDot} ink={p.ink} />
        <Hero
          label={t().widgetUi.logged(shown.title)}
          labelColor={p.okText}
          time={formatClock(shown.at)}
          sub={t().widgetUi.fixHint}
          ink={p.ink}
          muted={p.muted}
        />
        <Button
          text={t().widgetUi.editOrUndo}
          background={p.okButton}
          color={p.white}
          link={eventLink(shown.eventId)}
          label={t().widgetUi.tapToEdit(shown.title)}
        />
      </Card>
    );
  }
  if (!sleep.lastEnd) {
    return (
      <Card
        background={p.card}
        link={TODAY_LINK}
        label={t().widgetUi.notAsleepA11y(t().widgetUi.noSleep)}
      >
        <Header view={view} p={p} dot={p.awakeDot} ink={p.ink} />
        <Empty
          title={t().widgetUi.noSleep}
          sub={t().widgetUi.noSleepHint}
          ink={p.ink}
          muted={p.muted}
        />
        {start}
      </Card>
    );
  }
  return (
    <Card
      background={p.card}
      link={TODAY_LINK}
      label={t().widgetUi.notAsleepA11y(t().widgetUi.wokeAt(clockOn(sleep.lastEnd, view.dayStart)))}
    >
      <Header view={view} p={p} dot={p.awakeDot} ink={p.ink} />
      <Hero
        label={t().widgetUi.awakeSince}
        time={formatClock(sleep.lastEnd)}
        sub={slept}
        ink={p.ink}
        muted={p.muted}
      />
      {start}
    </Card>
  );
}

function DiaperCard({ view, p, ids, shown, pending }: CardProps) {
  const count = (
    <TextWidget
      text={t().widgetUi.diapersToday(view.today.diapers)}
      maxLines={1}
      style={{ fontSize: 11, color: p.muted }}
    />
  );
  if (shown) {
    return (
      <Card
        background={p.card}
        link={eventLink(shown.eventId)}
        label={t().widgetUi.tapToEdit(shown.title)}
      >
        <Header view={view} p={p} dot={p.okDot} ink={p.ink} right={count} />
        <Hero
          label={t().widgetUi.logged(shown.title)}
          labelColor={p.okText}
          time={formatClock(shown.at)}
          sub={t().widgetUi.fixHint}
          ink={p.ink}
          muted={p.muted}
        />
        <Button
          text={t().widgetUi.editOrUndo}
          background={p.okButton}
          color={p.white}
          link={eventLink(shown.eventId)}
          label={t().widgetUi.tapToEdit(shown.title)}
        />
      </Card>
    );
  }
  const last = view.lastDiaper;
  const chips = <Row>{diaperChips(p, ids, undefined, pending)}</Row>;
  if (!last) {
    return (
      <Card background={p.card} link={TODAY_LINK} label={t().widgetUi.noDiaper}>
        <Header view={view} p={p} dot={p.diaperDot} ink={p.ink} right={count} />
        <Empty
          title={t().widgetUi.noDiaper}
          sub={t().widgetUi.noDiaperHint}
          ink={p.ink}
          muted={p.muted}
        />
        {chips}
      </Card>
    );
  }
  const label =
    last.at >= view.dayStart
      ? t().widgetUi.withAmount(t().widgetUi.lastDiaper, diaperLabel(last.kind))
      : t().widgetUi.withAmount(
          t().widgetUi.withAmount(t().widgetUi.lastDiaper, formatShortDate(last.at)),
          diaperLabel(last.kind),
        );
  return (
    <Card
      background={p.card}
      link={eventLink(last.id)}
      label={t().widgetUi.lastDiaperA11y(
        `${clockOn(last.at, view.dayStart)} · ${diaperLabel(last.kind)}`,
      )}
    >
      <Header view={view} p={p} dot={p.diaperDot} ink={p.ink} right={count} />
      <Hero label={label} time={formatClock(last.at)} ink={p.ink} muted={p.muted} />
      {chips}
    </Card>
  );
}

function StatusItem({
  dot,
  time,
  text,
  p,
}: {
  dot: Hex;
  time: string;
  text: string;
  p: WidgetPalette;
}) {
  return (
    <FlexWidget style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Dot color={dot} gap={5} />
      <TextWidget
        text={time}
        maxLines={1}
        style={{ fontSize: 12, fontFamily: MONO, color: p.ink }}
      />
      <TextWidget text={text} maxLines={1} style={{ fontSize: 12, color: p.ink, marginLeft: 4 }} />
    </FlexWidget>
  );
}

function QuickCard({ view, p, ids, shown, pending }: CardProps) {
  const { lastFeed, lastFeedAmount, sleep, lastDiaper } = view;
  // 这一行和今天页的时间线一样只写钟点，所以只放过去 24 小时里的，更早的会被看成今天的。
  // 一行放不下日期：三项都带上日期时最后一项会被挤出卡片。
  const recent = (at: number) => at > view.now - 86_400_000;
  const items: ReactElement[] = [];
  if (lastFeed && lastFeedAmount && recent(lastFeed.at)) {
    items.push(
      <StatusItem
        key="feed"
        dot={p.feedDot}
        time={formatClock(lastFeed.at)}
        text={lastFeedAmount}
        p={p}
      />,
    );
  }
  if (sleep.status !== 'awake' && recent(sleep.since)) {
    items.push(
      <StatusItem
        key="sleep"
        dot={p.sleepDot}
        time={formatClock(sleep.since)}
        text={sleep.status === 'asleep' ? t().widgetUi.asleepShort : t().widgetUi.timerOn}
        p={p}
      />,
    );
  } else if (sleep.status === 'awake' && sleep.lastEnd && recent(sleep.lastEnd)) {
    items.push(
      <StatusItem
        key="sleep"
        dot={p.awakeDot}
        time={formatClock(sleep.lastEnd)}
        text={t().widgetUi.awakeShort}
        p={p}
      />,
    );
  }
  if (lastDiaper && recent(lastDiaper.at)) {
    items.push(
      <StatusItem
        key="diaper"
        dot={p.diaperDot}
        time={formatClock(lastDiaper.at)}
        text={diaperLabel(lastDiaper.kind)}
        p={p}
      />,
    );
  }
  const status = shown ? (
    <TextWidget
      text={t().widgetUi.quickLogged(shown.title)}
      maxLines={1}
      truncate="END"
      style={{ fontSize: 12, color: p.okText }}
    />
  ) : (
    <FlexWidget style={{ flexDirection: 'row', flexGap: 12 }}>{items}</FlexWidget>
  );

  const feedChip =
    shown?.button === 'feed' ? (
      <Chip
        flex={1.35}
        top={<SmallText text={t().widgetUi.chipDone} color={p.white} />}
        text={t().widgetUi.chipEdit}
        background={p.okButton}
        color={p.white}
        link={eventLink(shown.eventId)}
        label={t().widgetUi.tapToEdit(shown.title)}
      />
    ) : view.quickFeedAmount ? (
      <Chip
        flex={1.35}
        top={<SmallText text={t().today.feed} color={p.white} />}
        text={view.quickFeedAmount}
        mono
        background={p.accent}
        color={p.white}
        action={{ type: 'feed', id: ids.feed }}
        pending={pending}
        label={t().widgetUi.logFeed(view.quickFeedAmount)}
      />
    ) : (
      <Chip
        flex={1.35}
        top={<SmallText text={t().today.feed} color={p.white} />}
        text={t().widgetUi.pickAmount}
        background={p.accent}
        color={p.white}
        link={FEED_LINK}
        label={t().widgetUi.pickAmountA11y}
      />
    );

  const sleepChip =
    shown?.button === 'sleep' ? (
      <Chip
        top={<SmallText text={t().widgetUi.chipDone} color={p.white} />}
        text={t().widgetUi.chipEdit}
        background={p.okButton}
        color={p.white}
        link={eventLink(shown.eventId)}
        label={t().widgetUi.tapToEdit(shown.title)}
      />
    ) : sleep.status === 'asleep' ? (
      <Chip
        top={<Dot color={p.white} gap={0} />}
        text={t().widgetUi.awake}
        background={p.sleepButton}
        color={p.white}
        action={{ type: 'sleepEnd', sleepId: sleep.id }}
        pending={pending}
        label={t().widgetUi.logAwake}
      />
    ) : sleep.status === 'forgotten' ? (
      <Chip
        top={<Dot color={p.confirmText} gap={0} />}
        text={t().widgetUi.confirm}
        background={p.confirmButton}
        color={p.confirmText}
        link={eventLink(sleep.id)}
        label={t().widgetUi.confirmA11y}
      />
    ) : (
      <Chip
        top={<Dot color={p.white} gap={0} />}
        text={t().widgetUi.fellAsleep}
        background={p.sleepButton}
        color={p.white}
        action={{ type: 'sleepStart', id: ids.sleep }}
        pending={pending}
        label={t().widgetUi.startSleepA11y}
      />
    );

  return (
    <Card
      background={p.card}
      link={shown ? eventLink(shown.eventId) : TODAY_LINK}
      label={t().widgetUi.quickA11y(view.babyName)}
    >
      <FlexWidget
        style={{
          width: 'match_parent',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <FlexWidget style={{ flexDirection: 'row', alignItems: 'center' }}>
          {view.avatar ? <Avatar uri={view.avatar} size={AVATAR_WIDE} gap={7} /> : null}
          <TextWidget
            text={t().widgetUi.quickTitle(
              // 4×2 横向还很宽，放了头像也不用少放字（模拟器上 “Little Bean · 第 1 天” 加头像只占一半）。
              shortBabyName(view.babyName, 12),
              view.dayNumber,
            )}
            maxLines={1}
            style={{ fontSize: 14, fontFamily: SERIF, color: p.ink }}
          />
        </FlexWidget>
        {view.showSync ? (
          <SyncPill view={view} p={p} />
        ) : (
          <TextWidget
            text={formatShortDate(view.dayStart)}
            maxLines={1}
            style={{ fontSize: 11, color: p.muted }}
          />
        )}
      </FlexWidget>
      {status}
      <Row>{[feedChip, ...diaperChips(p, ids, shown, pending), sleepChip]}</Row>
    </Card>
  );
}

function Stat({
  dot,
  label,
  value,
  unit,
  p,
}: {
  dot: Hex;
  label: string;
  value: string;
  unit: string;
  p: WidgetPalette;
}) {
  return (
    <FlexWidget style={{ flex: 1, flexDirection: 'column' }}>
      <FlexWidget style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Dot color={dot} size={6} gap={5} />
        <TextWidget text={label} maxLines={1} style={{ fontSize: 11, color: p.muted }} />
      </FlexWidget>
      <FlexWidget style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
        <TextWidget
          text={value}
          maxLines={1}
          style={{ fontSize: 24, fontFamily: MONO, color: p.ink }}
        />
        <TextWidget
          text={unit}
          maxLines={1}
          style={{ fontSize: 12, color: p.muted, marginLeft: 3, marginBottom: 4 }}
        />
      </FlexWidget>
    </FlexWidget>
  );
}

function SummaryCard({ view, p, size }: CardProps) {
  const { today } = view;
  const hours = sleptHours(view);
  const width = Math.round(size.width - 2 * PADDING_X);
  return (
    <Card
      background={p.card}
      link={TODAY_LINK}
      label={t().widgetUi.todayA11y(
        view.babyName,
        today.feeds,
        view.todayAmount,
        today.diapers,
        hours,
      )}
    >
      <FlexWidget
        style={{
          width: 'match_parent',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <FlexWidget style={{ flexDirection: 'row', alignItems: 'center' }}>
          {view.avatar ? <Avatar uri={view.avatar} size={AVATAR_WIDE} gap={7} /> : null}
          <TextWidget
            text={t().widgetUi.todayOf(shortBabyName(view.babyName, view.avatar ? 14 : 16))}
            maxLines={1}
            style={{ fontSize: 15, fontFamily: SERIF, color: p.ink }}
          />
        </FlexWidget>
        {view.showSync ? (
          <SyncPill view={view} p={p} />
        ) : (
          <TextWidget
            // 系统定时刷新可能晚于 0 点，写明日期，显示的永远是这一天的真实数字。
            text={formatShortDate(view.dayStart)}
            maxLines={1}
            style={{ fontSize: 11, color: p.muted }}
          />
        )}
      </FlexWidget>
      <FlexWidget style={{ width: 'match_parent', flexDirection: 'column' }}>
        <SvgWidget
          svg={daylineSvg(view.dayline, width, p)}
          style={{ width, height: DAYLINE_HEIGHT }}
        />
        <FlexWidget
          style={{ width: 'match_parent', flexDirection: 'row', justifyContent: 'space-between' }}
        >
          {['0', '6', '12', '18', '24'].map((hour) => (
            <TextWidget
              key={hour}
              text={hour}
              style={{ fontSize: 10, fontFamily: MONO, color: p.muted }}
            />
          ))}
        </FlexWidget>
      </FlexWidget>
      <FlexWidget style={{ width: 'match_parent', flexDirection: 'row' }}>
        <Stat
          dot={p.feedDot}
          // 今天还没喂过就不写“· 0ml”。
          label={
            today.feeds > 0
              ? t().widgetUi.withAmount(t().today.feed, view.todayAmount)
              : t().today.feed
          }
          value={`${today.feeds}`}
          unit={t().widgetUi.feedsCount(today.feeds)}
          p={p}
        />
        <Stat
          dot={p.diaperDot}
          label={t().today.diaper}
          value={`${today.diapers}`}
          unit={t().widgetUi.diapersUnit(today.diapers)}
          p={p}
        />
        <Stat
          dot={p.sleepDot}
          label={t().today.sleep}
          value={hours}
          unit={t().widgetUi.hoursUnit}
          p={p}
        />
      </FlexWidget>
    </Card>
  );
}

/** 未登录、没有宝宝、只看回忆：不写数据也不显示记录，温和地请人点开 App。 */
function Blocked({ message, p }: { message: string; p: WidgetPalette }) {
  return (
    <Card background={p.card} link={null} label={t().widgetUi.a11yApp(message)}>
      <TextWidget
        text={t().common.appName}
        style={{ fontSize: 15, fontFamily: SERIF, color: p.ink }}
      />
      <TextWidget text={message} maxLines={3} style={{ fontSize: 12, color: p.muted }} />
      <TextWidget text={t().widgetUi.openApp} style={{ fontSize: 12, color: p.accentText }} />
    </Card>
  );
}

const DEFAULT_SIZES: Record<WidgetName, WidgetSize> = {
  FeedWidget: { width: 168, height: 168 },
  SleepWidget: { width: 168, height: 168 },
  DiaperWidget: { width: 168, height: 168 },
  SummaryWidget: { width: 352, height: 168 },
  QuickWidget: { width: 352, height: 168 },
};

function renderWith(
  name: WidgetName,
  view: ShownWidgetView,
  p: WidgetPalette,
  ids: WidgetIds,
  shown: WidgetFeedback | undefined,
  size: WidgetSize,
  pending: WidgetButton | undefined,
): ReactElement {
  if (view.kind === 'blocked') return <Blocked message={view.message} p={p} />;
  const props = { view, p, ids, shown, size, pending };
  switch (name) {
    case 'FeedWidget':
      return <FeedCard {...props} />;
    case 'SleepWidget':
      return <SleepCard {...props} />;
    case 'SummaryWidget':
      return <SummaryCard {...props} />;
    case 'DiaperWidget':
      return <DiaperCard {...props} />;
    case 'QuickWidget':
      return <QuickCard {...props} />;
  }
}

/** 同时给出浅色和深色两份，系统按手机的深色模式选，切换时不用等刷新。 */
export function renderWidgetFor(
  name: WidgetName,
  view: ShownWidgetView,
  ids: WidgetIds,
  shown?: WidgetFeedback,
  size?: WidgetSize,
  pending?: WidgetButton,
): { light: ReactElement; dark: ReactElement } {
  const actual = size && size.width > 0 ? size : DEFAULT_SIZES[name];
  return {
    light: renderWith(name, view, widgetPalettes.light, ids, shown, actual, pending),
    dark: renderWith(name, view, widgetPalettes.dark, ids, shown, actual, pending),
  };
}
