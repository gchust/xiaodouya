import { t } from '@xiaodouya/shared';
import { useEffect, useRef, useState } from 'react';
import {
  FlatList,
  type HostInstance,
  Keyboard,
  Modal,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { withClockPart } from '../lib/dates';
import { colors, fonts, themedStyles } from '../theme';

type Part = 'hour' | 'minute';

const ROW = 44;
/** 露出半行，让人看得出能往下滑。 */
const VISIBLE_ROWS = 5.5;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);
/** 键盘收起后底部弹层还要 220ms 滑回原位（overlays.tsx），等它落稳再量按钮坐标。 */
const KEYBOARD_SETTLE_MS = 260;
const KEYBOARD_HIDE_FALLBACK_MS = 350;

const pad = (n: number) => String(n).padStart(2, '0');

interface Anchor {
  part: Part;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 时、分两个下拉，各点一下就改好。系统的表盘要先选小时再选分钟，
 * 只想把 14:20 改成 14:35 也得走两步，半夜单手很难点准。
 * 时刻可以选到未来，由 checkRecordTime 提示，这里不拦。
 */
export function ClockSelect({
  testID,
  label = '',
  value,
  onChange,
}: {
  testID: string;
  label?: string;
  value: number;
  onChange: (next: number) => void;
}) {
  const hourRef = useRef<HostInstance>(null);
  const minuteRef = useRef<HostInstance>(null);
  const pendingRef = useRef<(() => void) | null>(null);
  const [open, setOpen] = useState<Anchor | null>(null);
  const d = new Date(value);
  const current: Record<Part, number> = { hour: d.getHours(), minute: d.getMinutes() };

  useEffect(() => () => pendingRef.current?.(), []);

  const measureAndOpen = (part: Part) => {
    const ref = part === 'hour' ? hourRef : minuteRef;
    ref.current?.measureInWindow((x, y, width, height) => {
      if (width > 0 && height > 0) setOpen({ part, x, y, width, height });
    });
  };

  const show = (part: Part) => {
    pendingRef.current?.();
    pendingRef.current = null;
    if (!Keyboard.isVisible()) {
      measureAndOpen(part);
      return;
    }
    // 键盘开着时底部弹层被顶上去了，Modal 抢焦点会收起键盘让弹层滑下去，提前量的坐标会悬在半空。
    let settled = false;
    const afterHide = () => {
      if (settled) return;
      settled = true;
      sub.remove();
      clearTimeout(fallback);
      const timer = setTimeout(() => {
        pendingRef.current = null;
        measureAndOpen(part);
      }, KEYBOARD_SETTLE_MS);
      pendingRef.current = () => clearTimeout(timer);
    };
    const sub = Keyboard.addListener('keyboardDidHide', afterHide);
    const fallback = setTimeout(afterHide, KEYBOARD_HIDE_FALLBACK_MS);
    pendingRef.current = () => {
      settled = true;
      sub.remove();
      clearTimeout(fallback);
    };
    Keyboard.dismiss();
  };

  const button = (part: Part) => {
    const text = pad(current[part]);
    const expanded = open?.part === part;
    return (
      <Pressable
        ref={part === 'hour' ? hourRef : minuteRef}
        testID={`${testID}-${part}`}
        accessibilityRole="button"
        accessibilityLabel={
          part === 'hour' ? t().ui.pickHourOf(label, text) : t().ui.pickMinuteOf(label, text)
        }
        accessibilityState={{ expanded }}
        onPress={() => show(part)}
        style={[s.button, expanded ? { borderColor: colors.accent } : null]}
      >
        <Text style={s.buttonText}>{text}</Text>
        <Text maxFontSizeMultiplier={1.2} style={s.caret}>
          {expanded ? '▴' : '▾'}
        </Text>
      </Pressable>
    );
  };

  return (
    <View style={s.row}>
      {button('hour')}
      <Text style={s.colon}>:</Text>
      {button('minute')}
      {open ? (
        <Dropdown
          testID={testID}
          anchor={open}
          selected={current[open.part]}
          onClose={() => setOpen(null)}
          onPick={(n) => {
            setOpen(null);
            onChange(withClockPart(value, open.part, n));
          }}
        />
      ) : null}
    </View>
  );
}

function Dropdown({
  testID,
  anchor,
  selected,
  onClose,
  onPick,
}: {
  testID: string;
  anchor: Anchor;
  selected: number;
  onClose: () => void;
  onPick: (n: number) => void;
}) {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const options = anchor.part === 'hour' ? HOURS : MINUTES;
  const listHeight = Math.min(VISIBLE_ROWS, options.length) * ROW;
  const width = Math.max(anchor.width, 96);
  const left = Math.min(Math.max(anchor.x, 8), screenWidth - width - 8);
  // 记录弹层在屏幕下半部分，按钮下面通常放得下；放不下（大字体把弹层撑高了）就往上展开。
  const below = anchor.y + anchor.height + 4;
  const fitsBelow = below + listHeight <= screenHeight - insets.bottom - 8;
  const top = fitsBelow ? below : Math.max(insets.top + 8, anchor.y - 4 - listHeight);
  // 选中的那一项放在第二行，上面留一行看得出还能往回滑；
  // 末尾用 ceil 算上限让 ScrollView 贴底停住，23 和 59 不会只露半行。
  const initialIndex = Math.max(
    0,
    Math.min(selected - 1, Math.ceil(options.length - VISIBLE_ROWS)),
  );

  return (
    <Modal
      transparent
      visible
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable
        testID={`${testID}-${anchor.part}-dismiss`}
        accessibilityRole="button"
        accessibilityLabel={t().ui.close}
        onPress={onClose}
        style={s.backdrop}
      />
      <View style={[s.list, { top, left, width, height: listHeight }]}>
        <FlatList
          testID={`${testID}-${anchor.part}-list`}
          data={options}
          keyExtractor={(n) => String(n)}
          getItemLayout={(_, index) => ({ length: ROW, offset: ROW * index, index })}
          initialScrollIndex={initialIndex}
          showsVerticalScrollIndicator
          renderItem={({ item }) => {
            const text = pad(item);
            const isSelected = item === selected;
            return (
              <Pressable
                testID={`${testID}-${anchor.part}-${text}`}
                accessibilityRole="button"
                accessibilityLabel={
                  anchor.part === 'hour' ? t().ui.hourOption(text) : t().ui.minuteOption(text)
                }
                accessibilityState={{ selected: isSelected }}
                onPress={() => onPick(item)}
                style={({ pressed }) => [
                  s.option,
                  isSelected ? { backgroundColor: colors.sand } : null,
                  pressed ? { backgroundColor: colors.track } : null,
                ]}
              >
                <Text style={[s.optionText, isSelected ? s.optionSelected : null]}>{text}</Text>
              </Pressable>
            );
          }}
        />
      </View>
    </Modal>
  );
}

const s = themedStyles(() => ({
  row: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4 },
  button: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 4,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 13,
  },
  buttonText: { fontFamily: fonts.monoRegular, fontSize: 14, color: colors.ink },
  caret: { fontSize: 10, color: colors.muted },
  colon: { fontFamily: fonts.monoRegular, fontSize: 14, color: colors.muted },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  list: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    borderRadius: 12,
    overflow: 'hidden',
    elevation: 6,
    shadowColor: colors.ink,
    shadowOpacity: 0.12,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 6 },
  },
  option: { height: ROW, justifyContent: 'center', paddingHorizontal: 14 },
  optionText: { fontFamily: fonts.monoRegular, fontSize: 15, color: colors.ink },
  optionSelected: { fontFamily: fonts.monoMedium, color: colors.accentText },
}));
