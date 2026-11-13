import type { Catalog } from '../zh';
import { plural } from './plural';

export const search: Catalog['search'] = {
  recordsPlaceholder: 'Search medicine, temperature, notes…',
  recordsA11y: 'Search records',
  recallPlaceholder: 'Search moments and letters',
  recallA11y: 'Search moments and letters',
  clear: 'Clear search',
  count: (n) => plural(n, 'result', 'results'),
  empty: (query) => `Nothing found for "${query}"`,
  emptySub: 'Try different words.',
  emptyFilterSub: 'Try different words, or switch the type above to All.',
  recallLink: 'Search',
  recallTitle: 'Search memories',
  backToRecall: 'Back to Memories',
  backRecallLink: '‹ Memories',
  recallHint: 'Search moments and letters to your baby, by title or text.',
  momentTag: 'Moment',
  letterTag: 'Letter',
  openA11y: (kind, title) => `${kind}: ${title}`,
};
