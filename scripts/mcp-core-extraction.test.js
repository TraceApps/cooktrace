/**
 * Static-analysis test guarding the MCP core-extraction refactor (the
 * webhooks + general REST API port). A narrow subset of MCP tools had
 * their query/write logic pulled into a standalone exported `xCore`
 * function so the new public REST API and webhook detection logic can
 * call the exact same implementation instead of duplicating it. This
 * only checks the export exists in source text, no db.js import, so it
 * runs without a compiled better-sqlite3 native binding.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const TOOLS_DIR = new URL('../server/lib/mcp/tools/', import.meta.url);

const EXPECTED_CORE_EXPORTS = {
  'list-cook-diary.js':     'listCookDiaryCore',
  'log-cook.js':            'logCookCore',
  'list-shopping-list.js':  'listShoppingListCore',
  'check-shopping-item.js': 'checkShoppingItemCore',
  'update-pantry-stock.js': 'updatePantryStockCore',
};

for (const [file, exportName] of Object.entries(EXPECTED_CORE_EXPORTS)) {
  test(`${file} exports ${exportName}`, () => {
    const src = readFileSync(new URL(file, TOOLS_DIR), 'utf8');
    assert.match(src, new RegExp(`export function ${exportName}\\(`));
    assert.match(src, new RegExp(exportName + '\\('), `register wrapper in ${file} should call ${exportName}`);
  });
}

const NOT_EXTRACTED = [
  'add-pantry-item.js', 'add-shopping-item.js', 'create-recipe.js',
  'remove-shopping-item.js', 'delete-cook-diary-entry.js',
  'get-recipe.js', 'search-recipes.js', 'recent-recipes.js',
  'list-pantry.js',
];

for (const file of NOT_EXTRACTED) {
  test(`${file} is intentionally NOT extracted (destroy/create-tier, or redundant with an existing federation route)`, () => {
    const src = readFileSync(new URL(file, TOOLS_DIR), 'utf8');
    assert.doesNotMatch(src, /export function \w+Core\(/);
  });
}
