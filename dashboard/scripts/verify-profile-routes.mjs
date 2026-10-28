// The Gateway owns the login/session boundary. This compatibility command runs its full real-handler integration suite.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
process.env.DASHBOARD_CHECKOUT ??= resolve(new URL('..', import.meta.url).pathname);
const gateway = resolve(process.env.GATEWAY_CHECKOUT || '../gateway');
await import(pathToFileURL(resolve(gateway, 'scripts/verify-integration.mjs')));
