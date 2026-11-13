import {
  type BreastSide,
  breastSeconds,
  createTapGuard,
  describeEvent,
  type EventData,
  type FeedMethod,
  finishBreastFeed,
  formatClock,
  formatMediaDuration,
  guardTap,
  isForgottenBreastFeed,
  isOpenBreastFeed,
  nextBreastSide,
  startBreastFeed,
  switchBreastSide,
  TAP_HOLD_MS,
  t,
} from '@xiaodouya/shared';
import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useApp, useNow, useRecords, useUnits } from '../lib/app';
import { colors, fonts, themedStyles } from '../theme';
import { useFeedback, useSheet } from '../ui/overlays';
import { Button, Chip, Mono, Muted, PressScale, SoftInput } from '../ui/primitives';
import { SmallStepper } from '../ui/SmallStepper';
import { type RecordTime, RecordTimeField } from '../ui/TimeField';

type FeedEvent = Extract<EventData, { type: 'feed' }>;

const SIDES = ['left', 'right'] as const;
const sideName = (side: BreastSide) =>
  side === 'left' ? t().records.breastLeftSide : t().records.breastRightSide;
const sideShort = (side: BreastSide) =>
  side === 'left' ? t().records.breastLeft : t().records.breastRight;
const clockOf = (seconds: number) => formatMediaDuration(seconds * 1000);

/** 喂奶弹层顶上的 `瓶喂 / 亲喂`。 */
export function FeedMethodSwitch({
  value,
  onChange,
}: {
  value: FeedMethod;
  onChange: (next: FeedMethod) => void;
}) {
  const options = [
    { method: 'bottle', label: t().records.feedBottle },
    { method: 'breast', label: t().records.feedBreast },
  ] as const;
  return (
    <View style={s.segment} accessibilityRole="tablist">
      {options.map(({ method, label }) => {
        const on = value === method;
        return (
          <Pressable
            key={method}
            testID={`feed-method-${method}`}
            accessibilityRole="tab"
            accessibilityLabel={t().records.feedMethodA11y(label)}
            accessibilityState={{ selected: on }}
            hitSlop={{ top: 6, bottom: 6 }}
            onPress={() => onChange(method)}
            style={[s.segmentItem, on ? s.segmentOn : null]}
          >
            <Text style={[s.segmentLabel, on ? s.segmentLabelOn : null]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** 一侧的大按钮。计时中显示这一侧喂了多久，正在喂的那一侧是实心的。 */
function SideButton({
  side,
  seconds,
  active,
  suggested,
  sub,
  label,
  onPress,
  testID,
}: {
  side: BreastSide;
  seconds: number | null;
  active: boolean;
  suggested: boolean;
  sub: string;
  label: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <PressScale
      testID={testID}
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      style={[s.side, suggested ? s.sideSuggested : null, active ? s.sideActive : null]}
      onPress={onPress}
    >
      <Text style={[s.sideLetter, active ? s.onAccent : null]}>{sideShort(side)}</Text>
      {seconds === null ? null : (
        <Mono
          weight="medium"
          style={[s.sideTime, active ? s.onAccent : null]}
          testID={`${testID}-time`}
        >
          {clockOf(seconds)}
        </Mono>
      )}
      <Text
        style={[
          s.sideSub,
          suggested ? { color: colors.accentText } : null,
          active ? s.onAccent : null,
        ]}
      >
        {sub}
      </Text>
    </PressScale>
  );
}

/**
 * 还没开始：选开始时间（刚刚 / 15 分钟前…），点一侧就写下一条没有结束的记录。
 * 弹层不关，接着显示计时；关掉也没关系，今天页的喂奶卡会接着计。
 */
export function BreastStart({ time }: { time: RecordTime }) {
  const app = useApp();
  const { events } = useRecords();
  const guard = useRef(createTapGuard({ holdMs: TAP_HOLD_MS })).current;
  const next = nextBreastSide(
    events.map((e) => e.data),
    Date.now(),
  );
  const start = (side: BreastSide) =>
    guardTap(guard, 'breast', Date.now, async () => {
      // 上一下已经开始了、画面还没换成计时：不能再开一条。
      const open = app.store.getSnapshot().events.some((e) => isOpenBreastFeed(e.data));
      if (open) return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      await app.write('event', { ...startBreastFeed(side, time.resolve()), byName: app.label });
    });
  return (
    <>
      <RecordTimeField time={time} />
      {next ? (
        <Text style={s.nextSide} testID="breast-next-side">
          {t().domain.events.nextBreastSide(next)}
        </Text>
      ) : null}
      <View style={s.sides}>
        {SIDES.map((side) => (
          <SideButton
            key={side}
            side={side}
            seconds={null}
            active={false}
            suggested={next === side}
            sub={next === side ? t().records.breastStartHere : sideName(side)}
            label={t().records.breastStartA11y(sideName(side))}
            testID={`breast-${side}`}
            onPress={() => void start(side)}
          />
        ))}
      </View>
      <Muted style={s.hint}>{t().records.breastHowTo}</Muted>
    </>
  );
}

/** 计时中：两侧各喂了多久，点另一侧换边，`结束` 保存。 */
export function BreastTimer({ id }: { id: string }) {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const units = useUnits();
  const { events } = useRecords();
  const now = useNow(1000);
  const guard = useRef(createTapGuard({ holdMs: TAP_HOLD_MS })).current;
  const entry = events.find((e) => e.id === id);
  const feed = entry && isOpenBreastFeed(entry.data) ? entry.data : null;
  if (!feed) {
    // 家人在另一台手机上点了结束，或者删掉了。
    return <Muted testID="breast-ended">{t().records.breastEnded}</Muted>;
  }
  const latest = (): FeedEvent | null => {
    const found = app.store.getSnapshot().events.find((e) => e.id === id)?.data;
    return found && isOpenBreastFeed(found) ? found : null;
  };
  const tapSide = (side: BreastSide) =>
    guardTap(guard, 'breast', Date.now, async () => {
      const current = latest();
      const switched = current ? switchBreastSide(current, side, Date.now()) : null;
      if (!switched) return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      await app.write('event', switched, id);
    });
  const finish = () =>
    guardTap(guard, 'breast', Date.now, async () => {
      const current = latest();
      if (!current) {
        sheet.close();
        return;
      }
      const done = finishBreastFeed(current, Date.now());
      await app.write('event', done, id);
      sheet.close();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast(`${t().records.logged} · ${describeEvent(done, Date.now(), units)}`, {
        undo: () => void app.write('event', current, id),
      });
    });
  const seconds = breastSeconds(feed, Math.max(now, Date.now()));
  const forgotten = isForgottenBreastFeed(feed, Date.now());
  return (
    <>
      <View style={s.timerHead}>
        <Muted>{t().records.breastStartedAt(formatClock(feed.at))}</Muted>
        <View style={s.total}>
          <Muted style={s.totalLabel}>{t().records.breastTotal}</Muted>
          <Mono weight="medium" style={s.totalTime} testID="breast-total">
            {clockOf(seconds.left + seconds.right)}
          </Mono>
        </View>
      </View>
      <View style={s.sides}>
        {SIDES.map((side) => {
          const active = feed.side === side;
          return (
            <SideButton
              key={side}
              side={side}
              seconds={seconds[side]}
              active={active}
              suggested={false}
              sub={active ? t().records.breastFeeding : t().records.breastSwitchHere}
              label={
                active
                  ? t().records.breastSideA11y(sideName(side), clockOf(seconds[side]))
                  : t().records.breastSwitchA11y(sideName(side), clockOf(seconds[side]))
              }
              testID={`breast-${side}`}
              onPress={() => void tapSide(side)}
            />
          );
        })}
      </View>
      {forgotten ? (
        <Text style={s.warn} testID="breast-forgotten">
          {t().records.breastForgotten}
        </Text>
      ) : null}
      <Button
        testID="breast-finish"
        label={t().records.breastFinish}
        onPress={() => void finish()}
      />
    </>
  );
}

/** 一侧的分钟数，步进 5 分钟，落在 5 的倍数上：12 分钟点 ＋ 是 15，点 − 是 10。 */
const MINUTE_STEP = 5;
const MAX_MINUTES = 120;
const stepMinutes = (value: number, direction: 1 | -1) => {
  const next =
    direction > 0
      ? Math.floor(value / MINUTE_STEP) * MINUTE_STEP + MINUTE_STEP
      : Math.ceil(value / MINUTE_STEP) * MINUTE_STEP - MINUTE_STEP;
  return Math.min(MAX_MINUTES, Math.max(0, next));
};
const minutesOf = (seconds: number | undefined) => Math.round((seconds ?? 0) / 60);

/**
 * 补记和修改喂完的亲喂：两侧各喂了几分钟、最后喂的是哪一侧。
 * 没动过的一侧保留原来的秒数，只改备注不会把 12 分 34 秒改成 13 分。
 */
export function BreastForm({
  initial,
  id,
  time,
  onSave,
}: {
  initial?: FeedEvent;
  id?: string;
  time: RecordTime;
  onSave: (data: FeedEvent) => void;
}) {
  const { events } = useRecords();
  const wasBreast = initial?.method === 'breast';
  const previous = (() => {
    if (wasBreast) return initial;
    let last: FeedEvent | null = null;
    for (const { data } of events) {
      if (data.type === 'feed' && data.method === 'breast' && data.endAt !== undefined) {
        if (!last || data.at > last.at) last = data;
      }
    }
    return last;
  })();
  const startLeft = previous ? minutesOf(previous.leftSec) : 10;
  const startRight = previous ? minutesOf(previous.rightSec) : 10;
  const [left, setLeft] = useState(startLeft);
  const [right, setRight] = useState(startRight);
  const [lastSide, setLastSide] = useState<BreastSide>(
    (wasBreast ? initial?.side : undefined) ?? 'right',
  );
  const [note, setNote] = useState(initial?.note ?? '');
  const side: BreastSide | undefined =
    left > 0 && right > 0 ? lastSide : left > 0 ? 'left' : right > 0 ? 'right' : lastSide;
  const secondsFor = (minutes: number, start: number, original: number | undefined) =>
    wasBreast && minutes === start && original !== undefined ? original : minutes * 60;
  const save = () => {
    const at = time.resolve();
    const leftSec = secondsFor(left, startLeft, initial?.leftSec);
    const rightSec = secondsFor(right, startRight, initial?.rightSec);
    const unchanged =
      wasBreast &&
      initial?.at === at &&
      initial.leftSec === leftSec &&
      initial.rightSec === rightSec &&
      initial.endAt !== undefined;
    onSave({
      ...initial,
      type: 'feed',
      at,
      ml: 0,
      method: 'breast',
      side,
      sideSince: undefined,
      leftSec,
      rightSec,
      endAt: unchanged ? initial.endAt : at + (leftSec + rightSec) * 1000,
      note: note.trim() || undefined,
      // 亲喂不用奶粉，旧记录改成亲喂时也不能留着奶粉的快照，否则营养页会把它当瓶喂算。
      milkType: undefined,
      formulaId: undefined,
      formula: undefined,
    });
  };
  return (
    <>
      <RecordTimeField time={time} />
      <SmallStepper
        testPrefix="breast-left-min"
        label={t().records.breastLeftSide}
        value={String(left)}
        unit={t().records.breastMinutes}
        onDec={() => setLeft((v) => stepMinutes(v, -1))}
        onInc={() => setLeft((v) => stepMinutes(v, 1))}
      />
      <SmallStepper
        testPrefix="breast-right-min"
        label={t().records.breastRightSide}
        value={String(right)}
        unit={t().records.breastMinutes}
        onDec={() => setRight((v) => stepMinutes(v, -1))}
        onInc={() => setRight((v) => stepMinutes(v, 1))}
      />
      {left > 0 && right > 0 ? (
        <View style={s.lastSide}>
          <Muted>{t().records.breastLastSide}</Muted>
          <View style={s.lastSideChips}>
            {SIDES.map((option) => (
              <Chip
                key={option}
                testID={`breast-last-${option}`}
                label={sideName(option)}
                selected={lastSide === option}
                onPress={() => setLastSide(option)}
              />
            ))}
          </View>
        </View>
      ) : null}
      <SoftInput
        testID="feed-note"
        value={note}
        onChangeText={setNote}
        placeholder={t().records.feedNotePlaceholder}
        maxLength={200}
      />
      <Button
        testID="feed-save"
        label={id ? t().common.save : t().records.record}
        disabled={Boolean(time.check.error)}
        onPress={save}
      />
    </>
  );
}

const s = themedStyles(() => ({
  segment: {
    flexDirection: 'row',
    padding: 3,
    borderRadius: 999,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.line,
  },
  segmentItem: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 999 },
  segmentOn: { backgroundColor: colors.ink },
  segmentLabel: { fontSize: 14, color: colors.ink },
  segmentLabelOn: { color: colors.paper, fontWeight: '500' },
  nextSide: { fontSize: 13, color: colors.accentText },
  sides: { flexDirection: 'row', gap: 10 },
  side: {
    flex: 1,
    height: 112,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.paper,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  sideSuggested: { borderColor: colors.accent, borderWidth: 2 },
  sideActive: { backgroundColor: colors.accentFill, borderColor: colors.accentFill },
  sideLetter: { fontFamily: fonts.serifBold, fontSize: 24, lineHeight: 30, color: colors.ink },
  sideTime: { fontSize: 22, lineHeight: 24, color: colors.ink },
  sideSub: { fontSize: 12, color: colors.muted },
  onAccent: { color: colors.onAccent },
  hint: { fontSize: 12, lineHeight: 19 },
  timerHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  total: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  totalLabel: { fontSize: 13 },
  totalTime: { fontSize: 32, lineHeight: 34 },
  warn: { fontSize: 12, lineHeight: 19, color: colors.warnText },
  lastSide: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  lastSideChips: { flexDirection: 'row', gap: 8 },
}));
