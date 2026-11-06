import {
  formatFullDate,
  formatMoney,
  type MoneyGroup,
  moneyByCategory,
  moneyByGiver,
  moneyCategoryLabel,
  moneyTotals,
  t,
} from '@xiaodouya/shared';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRecords } from '../lib/app';
import { openMoneySheet, useLocalCurrency } from '../sheets/moneySheets';
import { colors, spacing, themedStyles } from '../theme';
import { useSheet } from '../ui/overlays';
import { Card, ListCard, Mono, Muted, PageTitle, SectionTitle } from '../ui/primitives';

/**
 * 小金库：余额、谁给了多少、按场合、明细。只是记账（issue #90）。
 * 不同币种分开算，不换算：汇率不是 App 该猜的。
 */
export function PiggyBankScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const sheet = useSheet();
  const { money } = useRecords();
  const localCurrency = useLocalCurrency();
  const entries = money.map((m) => m.data);
  const totals = moneyTotals(entries);
  const main = totals[0]?.currency ?? localCurrency;
  const fmt = (minor: number, currency: string, signed?: boolean) =>
    formatMoney(minor, currency, { localCurrency, signed });
  const givers = moneyByGiver(entries, main);
  const occasions = moneyByCategory(entries, 'in', main);
  const amountsText = (group: MoneyGroup) =>
    group.amounts.map((a) => fmt(a.minor, a.currency)).join(' + ');

  return (
    <ScrollView
      testID="piggy-screen"
      style={s.root}
      contentContainerStyle={[
        s.content,
        { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 32 },
      ]}
      showsVerticalScrollIndicator={false}
    >
      <View style={{ gap: 6, alignItems: 'flex-start' }}>
        <Pressable
          testID="piggy-back"
          accessibilityRole="button"
          accessibilityLabel={t().info.backToInfo}
          hitSlop={12}
          onPress={() => router.back()}
        >
          <Text style={s.back}>{t().info.backInfoLink}</Text>
        </Pressable>
        <View style={s.titleRow}>
          <PageTitle>{t().money.title}</PageTitle>
          <Pressable
            testID="piggy-add-page"
            accessibilityRole="button"
            accessibilityLabel={t().money.addA11y}
            hitSlop={12}
            onPress={() => openMoneySheet(sheet)}
          >
            <Text style={s.link}>{t().money.addLink}</Text>
          </Pressable>
        </View>
      </View>

      <Card style={s.summary}>
        <Muted style={s.summaryLabel}>{t().money.balance}</Muted>
        {totals.length === 0 ? (
          <Mono testID="piggy-balance" style={s.balance}>
            {fmt(0, localCurrency)}
          </Mono>
        ) : (
          totals.map((total, i) => (
            <View key={total.currency} style={{ gap: 2 }}>
              <Mono
                testID={i === 0 ? 'piggy-balance' : `piggy-balance-${total.currency}`}
                style={i === 0 ? s.balance : s.balanceSmall}
              >
                {fmt(total.balanceMinor, total.currency)}
              </Mono>
              <Mono testID={i === 0 ? 'piggy-totals' : undefined} style={s.totals}>
                {t().money.totals(
                  fmt(total.inMinor, total.currency),
                  fmt(total.outMinor, total.currency),
                )}
              </Mono>
            </View>
          ))
        )}
      </Card>

      {totals.length === 0 ? <Muted style={s.note}>{t().money.empty}</Muted> : null}

      {givers.length > 0 ? (
        <View style={s.section}>
          <SectionTitle>{t().money.byGiver}</SectionTitle>
          <ListCard>
            {givers.map((g, i) => (
              <GroupRow
                key={g.key ?? ''}
                testID={`piggy-giver-${g.key ?? ''}`}
                label={g.key ?? t().money.unknownGiver}
                muted={g.key === null}
                amount={amountsText(g)}
                count={g.count}
                last={i === givers.length - 1}
              />
            ))}
          </ListCard>
        </View>
      ) : null}

      {occasions.some((o) => o.key !== null) ? (
        <View style={s.section}>
          <SectionTitle>{t().money.byOccasion}</SectionTitle>
          <ListCard>
            {occasions.map((o, i) => {
              const label = moneyCategoryLabel(o.key ?? undefined);
              return (
                <GroupRow
                  key={o.key ?? ''}
                  testID={`piggy-category-${o.key ?? ''}`}
                  label={label ?? t().money.noOccasion}
                  muted={!label}
                  amount={amountsText(o)}
                  count={o.count}
                  last={i === occasions.length - 1}
                />
              );
            })}
          </ListCard>
        </View>
      ) : null}

      {money.length > 0 ? (
        <View style={s.section}>
          <SectionTitle>{t().money.history}</SectionTitle>
          <ListCard>
            {money.map((entry, i) => {
              const { data } = entry;
              const title =
                moneyCategoryLabel(data.category) ??
                (data.flow === 'in' ? t().money.flowIn : t().money.flowOut);
              const sub = [formatFullDate(data.happenedAt), data.flow === 'in' ? data.from : null]
                .filter(Boolean)
                .join(' · ');
              const amount = fmt(
                data.flow === 'in' ? data.amountMinor : -data.amountMinor,
                data.currency,
                true,
              );
              return (
                <Pressable
                  key={entry.id}
                  testID={`money-row-${i}`}
                  accessibilityRole="button"
                  accessibilityLabel={t().money.rowA11y(`${title} ${amount}`, sub)}
                  onPress={() => openMoneySheet(sheet, entry)}
                  style={[s.entryRow, i < money.length - 1 ? s.divider : null]}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text testID={`money-row-${i}-title`} style={s.rowLabel} numberOfLines={1}>
                      {title}
                    </Text>
                    <Muted style={{ fontSize: 11 }} numberOfLines={1}>
                      {sub}
                    </Muted>
                    {data.note ? (
                      <Muted style={{ fontSize: 12 }} numberOfLines={2}>
                        {data.note}
                      </Muted>
                    ) : null}
                  </View>
                  <Mono
                    style={[
                      s.entryAmount,
                      { color: data.flow === 'in' ? colors.greenText : colors.ink },
                    ]}
                  >
                    {amount}
                  </Mono>
                </Pressable>
              );
            })}
          </ListCard>
        </View>
      ) : null}

      <Muted testID="piggy-footer" style={s.note}>
        {t().money.footer}
      </Muted>
    </ScrollView>
  );
}

function GroupRow({
  testID,
  label,
  muted,
  amount,
  count,
  last,
}: {
  testID: string;
  label: string;
  muted: boolean;
  amount: string;
  count: number;
  last: boolean;
}) {
  return (
    <View testID={testID} style={[s.groupRow, last ? null : s.divider]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[s.rowLabel, muted ? { color: colors.muted } : null]} numberOfLines={1}>
          {label}
        </Text>
        <Muted style={{ fontSize: 11 }}>{t().money.count(count)}</Muted>
      </View>
      <Mono testID={`${testID}-amount`} style={s.groupAmount}>
        {amount}
      </Mono>
    </View>
  );
}

const s = themedStyles(() => ({
  root: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: spacing.page, gap: 16 },
  back: { fontSize: 14, color: colors.muted, padding: 4, marginLeft: -4 },
  titleRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  link: { fontSize: 13, color: colors.accentText },
  summary: { gap: 8 },
  summaryLabel: { fontSize: 12 },
  balance: { fontSize: 32, color: colors.ink },
  balanceSmall: { fontSize: 20, color: colors.ink },
  totals: { fontSize: 12, color: colors.muted },
  section: { gap: 10 },
  note: { fontSize: 11, lineHeight: 18 },
  groupRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11 },
  entryRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11 },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.rule },
  rowLabel: { fontSize: 14, color: colors.ink },
  groupAmount: { fontSize: 13, color: colors.ink },
  entryAmount: { fontSize: 14 },
}));
