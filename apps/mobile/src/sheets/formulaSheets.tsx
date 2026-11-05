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
  t,
} from '@xiaodouya/shared';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useApp, useRecords, useRegion } from '../lib/app';
import { colors } from '../theme';
import { useDeleteConfirm } from '../ui/DeleteConfirm';
import { useFeedback } from '../ui/overlays';
import { Button, Chip, Field, Muted, SectionTitle } from '../ui/primitives';

const milkLabel = (type: MilkType): string => t().nutritionUi[type];

function milkSummary(milk: FeedMilk): string {
  if (!milk.milkType) return t().nutritionUi.milkTypeOptional;
  if (milk.milkType !== 'formula') return milkLabel(milk.milkType);
  return milk.formula
    ? t().nutritionUi.formulaNamed(milk.formula.name)
    : t().nutritionUi.formulaUnchosen;
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
        accessibilityLabel={t().nutritionUi.milkToggleA11y(
          milkSummary(value),
          open ? t().nutritionUi.collapse : t().nutritionUi.change,
        )}
        accessibilityState={{ expanded: open }}
        hitSlop={{ top: 8, bottom: 8 }}
        onPress={() => setOpen((v) => !v)}
        style={s.milkRow}
      >
        <Text style={s.milkText} numberOfLines={1} testID="feed-milk-summary">
          {milkSummary(value)}
        </Text>
        <Muted>{open ? t().nutritionUi.collapseLink : t().nutritionUi.changeLink}</Muted>
      </Pressable>
      {open ? (
        <View style={s.milkPanel}>
          <View style={s.chips}>
            {(['formula', 'breast', 'mixed'] as const).map((type) => (
              <Chip
                key={type}
                testID={`milk-${type}`}
                label={milkLabel(type)}
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
                label={t().nutritionUi.addFormulaChip}
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
  heading,
}: {
  onDone: (id: string) => void;
  onCancel?: () => void;
  /** 在别的弹层里打开时，那个弹层的标题说明不了现在在做什么。 */
  heading?: string;
}) {
  const region = useRegion();
  const [picked, setPicked] = useState<{ preset: FormulaPreset | null } | null>(null);
  if (picked) {
    return (
      <>
        {heading ? <SectionTitle>{heading}</SectionTitle> : null}
        <FormulaEditor
          preset={picked.preset}
          initialForm={picked.preset ? presetToForm(picked.preset) : emptyFormulaForm()}
          onDone={onDone}
        />
      </>
    );
  }
  return (
    <>
      {heading ? <SectionTitle>{heading}</SectionTitle> : null}
      <Button
        testID="formula-manual"
        tone="outline"
        label={t().nutritionUi.manual}
        onPress={() => setPicked({ preset: null })}
      />
      <Muted>{t().nutritionUi.presetHint}</Muted>
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
            <Muted>{preset.label ? t().nutritionUi.hasLabel : t().nutritionUi.nameOnly}</Muted>
          </Pressable>
        ))}
      </View>
      {onCancel ? (
        <Button testID="formula-back" tone="ghost" label={t().common.back} onPress={onCancel} />
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
  const confirmDelete = useDeleteConfirm();
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
    toast(t().nutritionUi.formulaDeleted, {
      undo: () => void app.write('event', existing, id),
    });
  };

  return (
    <>
      {preset?.label ? (
        <Muted style={s.hint}>
          {t().nutritionUi.presetSource(preset.label.source.label, preset.label.source.version)}
        </Muted>
      ) : preset ? (
        <Muted style={s.hint} testID="formula-name-only">
          {t().nutritionUi.presetNoData}
        </Muted>
      ) : null}
      <Field
        testID="formula-name"
        label={t().nutritionUi.name}
        value={form.name}
        onChangeText={(name) => setForm((f) => ({ ...f, name }))}
        placeholder={t().nutritionUi.namePlaceholder}
        maxLength={60}
      />
      <View style={s.chips}>
        <Chip
          testID="formula-basis-100ml"
          label={t().nutritionUi.per100ml}
          selected={form.basis === 'per100ml'}
          onPress={() => setForm((f) => ({ ...f, basis: 'per100ml' }))}
        />
        <Chip
          testID="formula-basis-100g"
          label={t().nutritionUi.per100g}
          selected={form.basis === 'per100g'}
          onPress={() => setForm((f) => ({ ...f, basis: 'per100g' }))}
        />
      </View>
      {form.basis === 'per100g' ? (
        <>
          <Field
            testID="formula-ratio"
            label={t().nutritionUi.powderPer100ml}
            value={form.powderGPer100ml}
            onChangeText={(powderGPer100ml) => setForm((f) => ({ ...f, powderGPer100ml }))}
            keyboardType="decimal-pad"
            mono
          />
          <Muted style={s.hint}>{t().nutritionUi.per100gHint}</Muted>
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
        {t().nutritionUi.blankNote(id ? t().nutritionUi.editOnlyFuture : '')}
      </Muted>
      {error ? (
        <Text style={s.error} testID="formula-error">
          {error}
        </Text>
      ) : null}
      <Button testID="formula-save" label={t().common.save} onPress={() => void save()} />
      {id && existing ? (
        <Button
          testID="formula-delete"
          tone="ghost"
          label={t().nutritionUi.deleteFormula}
          onPress={() => confirmDelete({ kind: 'formula', name: existing.name }, remove)}
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
          label={t().nutritionUi.nutrientField(nutrientMeta[name].label, unitLabel)}
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
