import {
  changeFormUnit,
  emptyFormulaForm,
  type FeedMilk,
  type FormulaData,
  type FormulaForm,
  type FormulaPreset,
  formulaFormFromData,
  formulaFromForm,
  formulaSnapshot,
  type MilkType,
  type NutrientKey,
  nutrientMeta,
  presetsForRegion,
  presetToForm,
} from '@xiaodouya/shared';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useApp, useRecords, useRegion } from '../lib/app';
import { colors } from '../theme';
import { useFeedback } from '../ui/overlays';
import { Button, Chip, Field, Muted } from '../ui/primitives';

const MILK_LABELS: Record<MilkType, string> = { formula: '奶粉', breast: '母乳', mixed: '混合' };

function milkSummary(milk: FeedMilk): string {
  if (!milk.milkType) return '奶类型（可选）';
  if (milk.milkType !== 'formula') return MILK_LABELS[milk.milkType];
  return milk.formula ? `奶粉 · ${milk.formula.name}` : '奶粉 · 还没选是哪一款';
}

/**
 * 喂奶弹层里的奶类型。默认收起，沿用上一次，记喂奶不多一步；只有要换的时候才展开。
 */
export function MilkChooser({
  value,
  onChange,
  onAddFormula,
}: {
  value: FeedMilk;
  onChange: (milk: FeedMilk) => void;
  onAddFormula: () => void;
}) {
  const { formulas } = useRecords();
  const [open, setOpen] = useState(false);
  const pickType = (type: MilkType) => {
    if (value.milkType === type) onChange({ milkType: undefined });
    else if (type !== 'formula') onChange({ milkType: type });
    else {
      const only = formulas.length === 1 ? formulas[0] : undefined;
      onChange(
        only
          ? { milkType: 'formula', formulaId: only.id, formula: formulaSnapshot(only.data) }
          : { milkType: 'formula' },
      );
    }
  };
  return (
    <View style={s.chooser}>
      <Pressable
        testID="feed-milk-toggle"
        accessibilityRole="button"
        accessibilityLabel={`奶类型：${milkSummary(value)}，点一下${open ? '收起' : '更改'}`}
        accessibilityState={{ expanded: open }}
        hitSlop={{ top: 8, bottom: 8 }}
        onPress={() => setOpen((v) => !v)}
        style={s.milkRow}
      >
        <Text style={s.milkText} numberOfLines={1} testID="feed-milk-summary">
          {milkSummary(value)}
        </Text>
        <Muted>{open ? '收起' : '更改'}</Muted>
      </Pressable>
      {open ? (
        <View style={s.milkPanel}>
          <View style={s.chips}>
            {(['formula', 'breast', 'mixed'] as const).map((type) => (
              <Chip
                key={type}
                testID={`milk-${type}`}
                label={MILK_LABELS[type]}
                selected={value.milkType === type}
                onPress={() => pickType(type)}
              />
            ))}
          </View>
          {value.milkType === 'formula' ? (
            <View style={s.chips}>
              {formulas.map((formula) => (
                <Chip
                  key={formula.id}
                  testID={`formula-choice-${formula.data.name}`}
                  label={formula.data.name}
                  selected={value.formulaId === formula.id}
                  onPress={() =>
                    onChange({
                      milkType: 'formula',
                      formulaId: formula.id,
                      formula: formulaSnapshot(formula.data),
                    })
                  }
                />
              ))}
              <Chip
                testID="formula-add"
                label="＋ 添加奶粉"
                selected={false}
                onPress={onAddFormula}
              />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** 添加奶粉：先选预置或手动，都进同一张表单，保存前能对照罐身看一遍。 */
export function AddFormulaFlow({
  onDone,
  onCancel,
}: {
  onDone: (id: string) => void;
  onCancel?: () => void;
}) {
  const region = useRegion();
  const [picked, setPicked] = useState<{ preset: FormulaPreset | null } | null>(null);
  if (picked) {
    return (
      <FormulaEditor
        preset={picked.preset}
        initialForm={picked.preset ? presetToForm(picked.preset) : emptyFormulaForm()}
        onDone={onDone}
      />
    );
  }
  return (
    <>
      <Button
        testID="formula-manual"
        tone="outline"
        label="手动填写"
        onPress={() => setPicked({ preset: null })}
      />
      <Muted>或者从常见的奶粉开始。这里只是列出来，不代表推荐。</Muted>
      <View>
        {presetsForRegion(region.id).map((preset) => (
          <Pressable
            key={preset.id}
            testID={`formula-preset-${preset.id}`}
            accessibilityRole="button"
            accessibilityLabel={preset.name}
            onPress={() => setPicked({ preset })}
            style={s.presetRow}
          >
            <Text style={s.presetName}>{preset.name}</Text>
            <Muted>
              {preset.label ? '带标签数值，请对照罐身核对' : '只有名字，请对照罐身录入'}
            </Muted>
          </Pressable>
        ))}
      </View>
      {onCancel ? (
        <Button testID="formula-back" tone="ghost" label="返回" onPress={onCancel} />
      ) : null}
    </>
  );
}

const SIMPLE_FIELDS: readonly NutrientKey[] = ['proteinG', 'fatG', 'carbsG', 'calciumMg', 'ironMg'];

export function FormulaEditor({
  id,
  existing,
  preset,
  initialForm,
  onDone,
}: {
  id?: string;
  existing?: FormulaData;
  preset?: FormulaPreset | null;
  initialForm?: FormulaForm;
  onDone: (id: string) => void;
}) {
  const app = useApp();
  const { toast } = useFeedback();
  const [form, setForm] = useState<FormulaForm>(
    () => initialForm ?? (existing ? formulaFormFromData(existing) : emptyFormulaForm()),
  );
  const [error, setError] = useState<string | null>(null);
  const setField = (key: NutrientKey, text: string) =>
    setForm((f) => ({ ...f, fields: { ...f.fields, [key]: text } }));

  const save = async () => {
    const result = formulaFromForm(
      form,
      existing ?? (preset ? ({ presetId: preset.id } as FormulaData) : undefined),
    );
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onDone(await app.write('event', result.data, id));
  };

  const remove = async () => {
    if (!id || !existing) return;
    await app.remove(id);
    onDone(id);
    toast('已删除这款奶粉，已经记下的喂奶不受影响', {
      undo: () => void app.write('event', existing, id),
    });
  };

  return (
    <>
      {preset?.label ? (
        <Muted style={s.hint}>
          数值来自{preset.label.source.label}（{preset.label.source.version}
          ）。配方会换版，请对照罐身核对，以罐身标签为准。
        </Muted>
      ) : preset ? (
        <Muted style={s.hint} testID="formula-name-only">
          这款还没有核实过的数据，请对照罐身的营养成分表录入。不填也能保存，算的时候会显示数据不足。
        </Muted>
      ) : null}
      <Field
        testID="formula-name"
        label="名称"
        value={form.name}
        onChangeText={(name) => setForm((f) => ({ ...f, name }))}
        placeholder="比如：牌子和段数"
        maxLength={60}
      />
      <View style={s.chips}>
        <Chip
          testID="formula-basis-100ml"
          label="每 100 ml 冲好的奶"
          selected={form.basis === 'per100ml'}
          onPress={() => setForm((f) => ({ ...f, basis: 'per100ml' }))}
        />
        <Chip
          testID="formula-basis-100g"
          label="每 100 g 奶粉"
          selected={form.basis === 'per100g'}
          onPress={() => setForm((f) => ({ ...f, basis: 'per100g' }))}
        />
      </View>
      {form.basis === 'per100g' ? (
        <>
          <Field
            testID="formula-ratio"
            label="每 100 ml 冲好的奶用多少克粉"
            value={form.powderGPer100ml}
            onChangeText={(powderGPer100ml) => setForm((f) => ({ ...f, powderGPer100ml }))}
            keyboardType="decimal-pad"
            mono
          />
          <Muted style={s.hint}>
            标签按每 100 g 给的，要靠罐身的冲调比例才能换算。没填就算不出来，不会猜。
          </Muted>
        </>
      ) : null}
      <NutrientField
        name="energyKcal"
        unitLabel={form.energyUnit === 'kj' ? 'kJ' : 'kcal'}
        value={form.fields.energyKcal}
        onChange={setField}
        units={[
          { id: 'kcal', label: 'kcal', on: form.energyUnit === 'kcal' },
          { id: 'kj', label: 'kJ', on: form.energyUnit === 'kj' },
        ]}
        onUnit={(unit) => setForm((f) => changeFormUnit(f, 'energy', unit as 'kcal' | 'kj'))}
      />
      <View style={s.grid}>
        {SIMPLE_FIELDS.map((key) => (
          <View key={key} style={s.gridItem}>
            <NutrientField
              name={key}
              unitLabel={nutrientMeta[key].unit}
              value={form.fields[key]}
              onChange={setField}
            />
          </View>
        ))}
      </View>
      <NutrientField
        name="vitaminDUg"
        unitLabel={form.vitaminDUnit === 'iu' ? 'IU' : 'µg'}
        value={form.fields.vitaminDUg}
        onChange={setField}
        units={[
          { id: 'ug', label: 'µg', on: form.vitaminDUnit === 'ug' },
          { id: 'iu', label: 'IU', on: form.vitaminDUnit === 'iu' },
        ]}
        onUnit={(unit) => setForm((f) => changeFormUnit(f, 'vitaminD', unit as 'ug' | 'iu'))}
      />
      <Muted style={s.hint}>
        没填的营养素会显示数据不足，不会当 0 算。
        {id ? '改动只影响之后的喂奶，已经记下的不变。' : ''}
      </Muted>
      {error ? (
        <Text style={s.error} testID="formula-error">
          {error}
        </Text>
      ) : null}
      <Button testID="formula-save" label="保存" onPress={() => void save()} />
      {id ? (
        <Button
          testID="formula-delete"
          tone="ghost"
          label="删除这款奶粉"
          onPress={() => void remove()}
        />
      ) : null}
    </>
  );
}

function NutrientField({
  name,
  unitLabel,
  value,
  onChange,
  units,
  onUnit,
}: {
  name: NutrientKey;
  unitLabel: string;
  value: string;
  onChange: (key: NutrientKey, text: string) => void;
  units?: { id: string; label: string; on: boolean }[];
  onUnit?: (id: string) => void;
}) {
  return (
    <View style={s.nutrientField}>
      <View style={{ flex: 1 }}>
        <Field
          testID={`formula-field-${name}`}
          label={`${nutrientMeta[name].label}（${unitLabel}）`}
          value={value}
          onChangeText={(text) => onChange(name, text)}
          keyboardType="decimal-pad"
          mono
        />
      </View>
      {units ? (
        <View style={s.unitChips}>
          {units.map((unit) => (
            <Chip
              key={unit.id}
              testID={`formula-unit-${unit.id}`}
              label={unit.label}
              selected={unit.on}
              onPress={() => onUnit?.(unit.id)}
              mono
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  chooser: { gap: 10 },
  milkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 12,
    backgroundColor: colors.paper,
  },
  milkText: { flex: 1, fontSize: 13, color: colors.inkSoft },
  milkPanel: { gap: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  presetRow: {
    gap: 2,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: colors.rule,
  },
  presetName: { fontSize: 14, color: colors.ink },
  hint: { fontSize: 12, lineHeight: 18 },
  error: { fontSize: 13, color: colors.danger },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  gridItem: { flexBasis: '47%', flexGrow: 1 },
  nutrientField: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  unitChips: { flexDirection: 'row', gap: 6, paddingBottom: 8 },
});
