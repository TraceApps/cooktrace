// platform.js for a phone connected to the server in CT_SERVER as CT_TOKEN.
// Signing in or out (setAuthToken) changes CT_TOKEN, as the app's own does.
const server = () => process.env.CT_SERVER || null;
export const isNative = true;
export const getServerUrl = server;
export const getAuthToken = () => process.env.CT_TOKEN || null;
export const setAuthToken = t => { if (t == null) delete process.env.CT_TOKEN; else process.env.CT_TOKEN = t; };
export const apiUrl = p => (server() || '') + p;
export const resolveAssetUrl = x => x;
export const getNativeMode = () => (server() ? 'server' : 'local');
export const setNativeMode = () => {}; export const setServerUrl = () => {};
export const needsNativeSetup = () => false; export const iconUrl = x => x;
export const loadImageMap = async () => ({}); export const setImageMap = () => {};
export const explainConnectError = e => String(e);
export const publicRecipeUrl = t => t; export const publicRecipeToken = () => null;
