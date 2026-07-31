import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.cooktrace.app',
  appName: 'CookTrace',
  webDir: 'dist',
  // In dev, point to your local Vite dev server for live-reload on device
  // Uncomment and set your machine's LAN IP when doing native dev builds:
  // server: { url: 'http://192.168.1.x:5173', cleartext: true },
  android: {
    buildOptions: {
      keystorePath: undefined,
      keystoreAlias: undefined,
    },
    // Allow the HTTPS WebView to load HTTP resources (images, fetches) from
    // the user's server. Self-hosted deployments overwhelmingly run over
    // plain HTTP on LAN; without this, Chromium's mixed-content block
    // refuses to load recipe images / uploads from an http:// server.
    // Chromium's localhost secure-origin exemption doesn't apply to .local
    // domains, so this is required once we set a real hostname below.
    // Safe: the WebView origin is a local virtual URL served by Capacitor's
    // AssetLoader — no network attacker can inject into it. Lives under
    // \`android\`, not \`server\` — Capacitor silently ignores it under
    // server.
    allowMixedContent: true,
  },
  server: {
    // WebView identity for Android autofill. Without an explicit hostname
    // Capacitor serves from https://localhost/, which is what password
    // managers like Bitwarden read as the site name — so saved credentials
    // show up as "localhost". Setting a hostname makes the WebView report
    // https://app.cooktrace.local/ instead. .local (RFC 6762) is reserved
    // for local/private use, no collision risk.
    //
    // ONE-TIME UPGRADE COST: origin change orphans localStorage /
    // sessionStorage / IndexedDB / cookies. SQLite via
    // @capacitor-community/sqlite is origin-independent — recipe data is
    // safe. Users on a linked server need to re-enter server URL + log in
    // once; standalone users see prefs default once.
    hostname: 'app.cooktrace.local',
    androidScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: '#0A0B0F',
      androidSplashResourceName: 'splash',
      showSpinner: false,
    },
    Keyboard: {
      resize: 'native',
    },
    StatusBar: {
      style: 'dark',
      backgroundColor: '#0A0B0F',
    },
    CapacitorSQLite: {
      iosDatabaseLocation: 'Library/CapacitorDatabase',
      iosIsEncryption: false,
      androidIsEncryption: false,
    },
  },
};

export default config;
