import type { Catalog } from '../zh';

export const nutritionUi: Catalog['nutritionUi'] = {
  prevDay: 'Previous day',
  nextDay: 'Next day',
  insufficient: 'Not enough data',
  note: 'Notes',
  estimate: (count, volume) =>
    `Estimated from the recorded amounts and formula labels. ${count} ${count === 1 ? 'feed' : 'feeds'}, ${volume} counted. We don't know whether your baby finished each feed, and solids and supplements aren't included.`,
  refNote:
    "Reference amounts aren't a target for every baby. If they stay below reference for several days, or you're worried, you can ask a doctor.",
  disclaimer:
    'An estimate, not a replacement for medical advice. For premature babies or special situations, please follow your doctor.',
  reference: (name, note) => `Reference amounts: ${name}. ${note}`,
  referenceNote: (note) => `${note}`,
  familyFormulas: 'Your formulas',
  addLink: '+ Add',
  noFormula:
    'No formulas set up. After adding one, choose it when recording a feed, and it can be estimated here.',
  missingRatio: "Mixing ratio missing, so it can't be calculated",
  noData: 'No nutrition data yet. Enter it from the can.',
  missing: (list) => `Missing ${list}`,
  listSep: ',',
  labelPrecedence: 'The can label takes precedence',
  editNamed: (name) => `Edit ${name}`,
  editFormula: 'Edit formula',
  formula: 'Formula',
  breast: 'Breast milk',
  mixed: 'Mixed',
  milkTypeOptional: 'Milk type (optional)',
  formulaNamed: (name) => `Formula · ${name}`,
  formulaUnchosen: 'Formula · not chosen yet',
  milkToggleA11y: (summary, action) => `Milk type: ${summary}. Tap to ${action}.`,
  collapse: 'hide',
  change: 'change',
  collapseLink: 'Hide',
  changeLink: 'Change',
  addFormulaChip: '+ Add formula',
  manual: 'Enter manually',
  presetHint: 'Or start from a common formula. These are only listed here, not recommended.',
  hasLabel: 'Has label values. Check them against the can.',
  nameOnly: 'Name only. Enter the values from the can.',
  formulaDeleted: "Formula deleted. Recorded feeds aren't affected.",
  presetSource: (source, version) =>
    `Values from ${source} (${version}). Formulas change between versions. Check against the can: the can label takes precedence.`,
  presetNoData:
    'This one has no verified data yet. Enter it from the nutrition table on the can. You can save without it, and it will show as not enough data.',
  name: 'Name',
  namePlaceholder: 'e.g. brand and stage',
  per100ml: 'Per 100 ml prepared',
  per100g: 'Per 100 g powder',
  powderPer100ml: 'Grams of powder per 100 ml prepared',
  per100gHint:
    'This label is per 100 g, so converting it needs the mixing ratio on the can. Without it nothing is calculated, and nothing is guessed.',
  blankNote: (extra) => `Nutrients left blank will show as not enough data, not as 0.${extra}`,
  editOnlyFuture: ' Changes only affect later feeds. Recorded ones stay the same.',
  deleteFormula: 'Delete this formula',
  nutrientField: (label, unit) => `${label} (${unit})`,
};
