import type { Catalog } from '../zh';

export const babies: Catalog['babies'] = {
  switchTitle: 'Choose a baby',
  switchA11y: (name) => `Showing ${name}. Tap to switch to another baby`,
  pickA11y: (name) => `Show ${name}'s records`,
  current: 'Showing',
  switchNote:
    'Records, the vaccine book, the piggy bank and documents are kept per baby. Formulas, the reading list and favorites are shared by the family.',
  switched: (name) => `Now showing ${name}`,
  viewAvatar: (name) => `View ${name}'s photo`,
  addAvatar: (name) => `Add a photo for ${name}`,
  addLink: '+ Add baby',
  addA11y: 'Add another baby',
  addTitle: 'Add another baby',
  addIntro: 'A name and birth time are enough. You can fill in the rest under Info later.',
  addWarning:
    "Once added, a baby can't be removed for now. Others in your family need to update Xiaodouya to the latest version to keep syncing.",
  addSubmit: 'Add',
  added: (name) => `Added ${name}. Now showing ${name}`,
  regionThisBaby: "This baby's region",
  shareFor: (name) => `Baby: ${name}`,
  feedReminderBody: (name) => `It's ${name}'s usual time between feeds.`,
  widgetFor: 'Widgets record for',
  widgetFollow: 'The baby chosen in the app',
  widgetHint:
    'Only on this phone. When following the app, switching babies on Today switches the widgets too.',
  widgetNameHint: "With more than one baby, widgets show the baby's name, not a nickname.",
  regionHint: "Sets this baby's vaccine book and default units. Only an admin can change it.",
  regionByAdmin: (name) => `The region starts as ${name}. An admin can change it under Info.`,
};
