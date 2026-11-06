import {
  createTapGuard,
  currencyChoices,
  currencyInfo,
  defaultMoneyCurrency,
  describeMoney,
  giverSuggestions,
  guardTap,
  lastUsedCurrency,
  type MoneyData,
  type MoneyFlow,
  mergeEdit,
  moneyCategoriesFor,
  moneyCategoryLabel,
  moneyInputText,
  parseMoneyInput,
  TAP_HOLD_MS,
  t,
} from '@xiaodouya/shared';
import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useApp, useRecords, useRegion } from '../lib/app';
import { doseTimestamp, editedDoseTimestamp } from '../lib/dates';
import { deviceRegionCode } from '../lib/device';
import { colors, fonts } from '../theme';
import { PastDatePicker } from '../ui/BirthPicker';
import { useDeleteConfirm } from '../ui/DeleteConfirm';
import { useFeedback, useSheet } from '../ui/overlays';
import { Button, Chip, Field, Muted } from '../ui/primitives';
import { DayChips } from '../ui/TimeField';

/** 家庭地区的币种：它显示成短符号（新加坡的 $），别的币种写成能分清的 S$、US$。 */
export function useLocalCurrency(): string {
  return defaultMoneyCurrency(useRegion(), deviceRegionCode());
}

export function openMoneySheet(
  sheet: ReturnType<typeof useSheet>,
  entry?: { id: string; data: MoneyData },
) {
  sheet.open(entry ? t().money.editTitle : t().money.addTitle, () => (
    <MoneySheet id={entry?.id} existing={entry?.data} />
  ));
}

/**
 * 记一笔或修改一笔。默认是收到、上一次用的币种、今天，填个金额就能存；
 * 谁给的、场合都是点胶囊，不用打字。
 */
export function MoneySheet({ id, existing }: { id?: string; existing?: MoneyData }) {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const confirmDelete = useDeleteConfirm();
  const region = useRegion();
  const { money } = useRecords();
  const localCurrency = useLocalCurrency();
  const guard = useRef(createTapGuard({ holdMs: TAP_HOLD_MS })).current;

  const [flow, setFlow] = useState<MoneyFlow>(existing?.flow ?? 'in');
  const [currency, setCurrency] = useState(
    () => existing?.currency ?? lastUsedCurrency(money) ?? localCurrency,
  );
  const [pickingCurrency, setPickingCurrency] = useState(false);
  const [amount, setAmount] = useState(() =>
    existing ? moneyInputText(existing.amountMinor, existing.currency) : '',
  );
  const [from, setFrom] = useState(existing?.from ?? '');
  const [category, setCategory] = useState<string | undefined>(existing?.category);
  const [date, setDate] = useState(() => new Date(existing?.happenedAt ?? Date.now()));
  const [note, setNote] = useState(existing?.note ?? '');
  const [error, setError] = useState<string | null>(null);

  const categories = moneyCategoriesFor(region, flow);
  // 修改以前记的、这个地区不列出的场合（换过地区）时，也要能看到它被选着。
  const shownCategories =
    category && !categories.includes(category) && moneyCategoryLabel(category)
      ? [category, ...categories]
      : categories;
  const others = (app.me?.members ?? []).map((m) => m.label);
  const givers = giverSuggestions(
    money.map((m) => m.data),
    [...others, ...t().family.labelSuggestions],
    8,
  );

  const changeFlow = (next: MoneyFlow) => {
    setFlow(next);
    if (category && !moneyCategoriesFor(region, next).includes(category)) setCategory(undefined);
  };

  const save = async () => {
    const parsed = parseMoneyInput(amount, currency);
    if (!parsed.ok) {
      const errors = t().money.errors;
      setError(
        parsed.reason === 'decimals'
          ? errors.decimals(currency, currencyInfo(currency).digits)
          : errors[parsed.reason],
      );
      return;
    }
    setError(null);
    const now = Date.now();
    const fields: MoneyData = {
      type: 'money',
      flow,
      amountMinor: parsed.minor,
      currency,
      happenedAt: existing
        ? editedDoseTimestamp(existing.happenedAt, date, now)
        : doseTimestamp(date, now),
      // 拿出的没有“谁给的”。改成拿出时清掉，免得按人统计里还算着它。
      from: flow === 'in' ? from.trim() || undefined : undefined,
      category,
      note: note.trim() || undefined,
    };
    const latest = id ? money.find((m) => m.id === id)?.data : undefined;
    const data: MoneyData =
      id && existing && latest
        ? mergeEdit(existing, latest, fields)
        : { ...fields, byName: app.label || undefined };
    const saved = await guardTap(guard, 'save', Date.now, () => app.write('event', data, id));
    if (!saved.ran) return;
    const recordId = saved.value;
    sheet.close();
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    const text = describeMoney(data, localCurrency);
    toast(id ? t().money.saved(text) : t().money.logged(text), {
      undo: id
        ? latest
          ? () => void app.write('event', latest, id)
          : undefined
        : () => void app.remove(recordId),
    });
  };

  const remove = async () => {
    if (!id || !existing) return;
    const latest = money.find((m) => m.id === id)?.data ?? existing;
    await app.remove(id);
    sheet.close();
    toast(t().money.deleted, { undo: () => void app.write('event', latest, id) });
  };

  return (
    <>
      <View style={s.chips}>
        <Chip
          testID="money-flow-in"
          label={t().money.flowIn}
          selected={flow === 'in'}
          onPress={() => changeFlow('in')}
        />
        <Chip
          testID="money-flow-out"
          label={t().money.flowOut}
          selected={flow === 'out'}
          onPress={() => changeFlow('out')}
        />
      </View>

      <View style={{ gap: 5 }}>
        <Muted style={s.label}>{t().money.amount}</Muted>
        <View style={s.amountRow}>
          <Pressable
            testID="money-currency"
            accessibilityRole="button"
            accessibilityLabel={t().money.currencyA11y(currency)}
            accessibilityState={{ expanded: pickingCurrency }}
            hitSlop={8}
            onPress={() => setPickingCurrency((v) => !v)}
            style={s.currency}
          >
            <Text testID="money-currency-code" style={s.currencyText}>
              {currency}
            </Text>
            <Text style={s.currencyCaret}>{pickingCurrency ? '▴' : '▾'}</Text>
          </Pressable>
          <TextInput
            testID="money-amount"
            accessibilityLabel={t().money.amount}
            value={amount}
            onChangeText={(text) => {
              setAmount(text);
              if (error) setError(null);
            }}
            keyboardType="decimal-pad"
            placeholder="0"
            placeholderTextColor={colors.off}
            selectionColor={colors.accent}
            maxLength={20}
            style={s.amountInput}
          />
        </View>
        {pickingCurrency ? (
          <View style={s.chips}>
            {currencyChoices.map((code) => (
              <Chip
                key={code}
                testID={`money-currency-${code}`}
                label={code}
                mono
                selected={code === currency}
                onPress={() => {
                  setCurrency(code);
                  setPickingCurrency(false);
                  if (error) setError(null);
                }}
              />
            ))}
          </View>
        ) : null}
        {error ? (
          <Text testID="money-error" style={s.error}>
            {error}
          </Text>
        ) : null}
      </View>

      {flow === 'in' ? (
        <View style={{ gap: 8 }}>
          <Field
            testID="money-from"
            label={t().money.from}
            value={from}
            onChangeText={setFrom}
            placeholder={t().money.fromPlaceholder}
            maxLength={40}
          />
          <View style={s.chips}>
            {givers.map((name, i) => (
              <Chip
                key={name}
                testID={`money-from-chip-${i}`}
                label={name}
                selected={from.trim() === name}
                onPress={() => setFrom(from.trim() === name ? '' : name)}
              />
            ))}
          </View>
        </View>
      ) : null}

      <View style={{ gap: 8 }}>
        <Muted style={s.label}>{flow === 'in' ? t().money.occasion : t().money.purpose}</Muted>
        <View style={s.chips}>
          {shownCategories.map((cid) => (
            <Chip
              key={cid}
              testID={`money-category-${cid}`}
              label={moneyCategoryLabel(cid) ?? cid}
              selected={category === cid}
              onPress={() => setCategory(category === cid ? undefined : cid)}
            />
          ))}
        </View>
      </View>

      <PastDatePicker label={t().money.date} testID="money-date" value={date} onChange={setDate} />
      <DayChips
        testID="money-date"
        value={date.getTime()}
        onChange={(at) => setDate(new Date(at))}
      />

      <Field
        testID="money-note"
        label={t().money.note}
        value={note}
        onChangeText={setNote}
        maxLength={200}
      />

      <Button
        testID="money-save"
        label={id ? t().common.save : t().money.save}
        onPress={() => void save()}
      />
      {id && existing ? (
        <Button
          testID="money-delete"
          tone="ghost"
          label={t().money.deleteEntry}
          onPress={() =>
            confirmDelete(
              { kind: 'money', summary: describeMoney(existing, localCurrency) },
              remove,
            )
          }
        />
      ) : null}
    </>
  );
}

const s = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  label: { fontSize: 12 },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    paddingBottom: 4,
  },
  currency: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.paper,
  },
  currencyText: { fontFamily: fonts.monoMedium, fontSize: 14, color: colors.ink },
  currencyCaret: { fontSize: 10, color: colors.muted },
  amountInput: {
    flex: 1,
    fontFamily: fonts.monoMedium,
    fontSize: 40,
    color: colors.ink,
    paddingVertical: 4,
  },
  error: { fontSize: 13, color: colors.danger },
});
