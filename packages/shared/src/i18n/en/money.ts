import type { Catalog } from '../zh';
import { plural } from './plural';

export const money: Catalog['money'] = {
  title: 'Piggy bank',
  flowIn: 'Money in',
  flowOut: 'Money out',
  balance: 'Balance',
  totals: (received, taken) => `In ${received} · Out ${taken}`,
  addLink: '+ Add',
  addA11y: 'Add an entry to the piggy bank',
  addTitle: 'Add an entry',
  editTitle: 'Edit this entry',
  openA11y: (balance) => `Open the piggy bank, balance ${balance}`,
  empty: 'Money gifts from family, who gave them and how much, can all be kept here.',
  amount: 'Amount',
  currency: 'Currency',
  currencyA11y: (code) => `Currency ${code}, tap to change`,
  from: 'From',
  fromPlaceholder: 'e.g. Grandma',
  occasion: 'Occasion',
  purpose: 'Where it went',
  date: 'Date',
  note: 'Note (optional)',
  save: 'Save',
  deleteEntry: 'Delete this entry',
  logged: (text) => `Saved · ${text}`,
  saved: (text) => `Updated · ${text}`,
  deleted: 'Entry deleted',
  byGiver: 'From',
  byOccasion: 'By occasion',
  history: 'All entries',
  count: (n) => plural(Number(n), 'entry', 'entries'),
  unknownGiver: 'Not noted',
  noOccasion: 'No occasion',
  rowA11y: (text, date) => `${text}, ${date}, tap to edit`,
  footer:
    'This only keeps a record. It is not connected to a bank and does not handle real money. Family members who record can see and edit it; those who only view memories cannot.',
  errors: {
    empty: 'Enter an amount',
    invalid: 'Use numbers only',
    zero: 'The amount needs to be more than 0',
    tooLarge: 'That amount is too large',
    decimals: (code, digits) =>
      digits === 0
        ? `${code} has no decimal places`
        : `${code} allows up to ${plural(digits, 'decimal place', 'decimal places')}`,
  },
};
