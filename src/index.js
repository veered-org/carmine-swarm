export { Room } from './room.js';
export { Stats } from './stats.js';

import { statsFetch } from './stats.js';

/*
 * Worker entry point.
 *
 * The client builds its socket URL from location.host with no path, so the
 * upgrade has to be answered at the root -- that is what lets public/index.html
 * stay byte-identical to the original Node version. Everything that is not an upgrade
 * falls through to the static assets binding, apart from the operator stats
 * endpoint.
 */
export default {
  async fetch(request, env) {
    if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
      // Single shared room, matching the original server's one-room behaviour.
      const id = env.ROOM.idFromName('main');
      return env.ROOM.get(id).fetch(request);
    }
    const url = new URL(request.url);
    if (url.pathname === '/api/stats') return statsFetch(env, request, url);
    return env.ASSETS.fetch(request);
  },
};
