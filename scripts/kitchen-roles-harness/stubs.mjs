export function requireAuth(req, res, next) { req.user = globalThis.__user; next(); }
export function userMgmtActive() { return true; }
export function dispatchWebhookEvent() {}
export function ensurePantryItems(userId, names) {
  globalThis.__pantryCalls.push({ userId, names: [...names] });
  return new Map();
}
export const scrapeRecipe = () => {}, fetchRecipeHtml = () => {}, extractFromHtml = () => {};
export const aiExtractRecipe = () => {};
export const scrapeWithRecipeScrapers = () => {}, isRecipeScrapersAvailable = () => false;
export const importRecipeFromText = () => {}, importPaprikaArchive = () => {}, scanRecipeZip = () => {},
  scanLoadedZip = () => {}, loadRecipeZip = () => {}, readImageFromLoadedZip = () => {},
  readZipImageBytes = () => {}, mealieEventImagePaths = () => [];
export const extractText = () => {}, detectFileType = () => {};
export const localizeDataUrl = v => v;
export const localizeRemoteImages = async v => v;
export function autoShareNewRecipe() {}
export const localizeDataUrls = async v => v;
export function deriveSodiumSalt(n) { return n || {}; }
export function notifyCommentReply() {}
export function sendRecipeShared() {}
export function isEmailConfigured() { return false; }
export function parseRecipeText() { return {}; }
export const HIGH_CONFIDENCE_THRESHOLD = 0.5;
export const hydrateRecipe = r => r;
export const matchSummary = () => ({ have: 0, total: 0 });
export const buildStockSet = () => new Set();
export const buildCategoryMap = () => new Map();
export const normaliseIngredientGroups = g => g;
export const safeJson = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
