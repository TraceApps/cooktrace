// node --import ./scripts/android-sync/register.mjs: run the Android app's own
// sync modules (src/lib/sync.js, api-native.js, db-native.js) in Node, with
// Capacitor swapped for the shims next to this file.
import './clock.mjs';
import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
