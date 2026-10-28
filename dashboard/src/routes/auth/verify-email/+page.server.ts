import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ setHeaders }) => {
  setHeaders({
    'Cache-Control': 'no-store, private',
    'Referrer-Policy': 'no-referrer',
  });
  // Auth0 may append a transaction state. It is neither rendered nor resumed here.
  return {};
};
