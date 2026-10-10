/**
 * What an app knows of the synced tables, as a number it sends with each
 * pull. An app writes every column it's sent into its own tables, so the
 * server sends a column or table added later only to apps that know it
 * (routes/sync.js LATER_COLS): 1, before 1.5 (none sent); 2, 1.5's (list
 * sources and notes, "any day" plans, allergens, recipe versions).
 */
export const SYNC_SCHEMA = 2;

/**
 * The fields of each synced table, as two edits of a row meet them.
 *
 * The same columns a device writes through /api/sync/push (TABLES[t].cols
 * in routes/sync.js, which checks it matches at load), plus deleted_at where
 * rows are soft-deleted: a delete is an edit too. db.js keeps, per row, when
 * each of these last changed (field_stamps); lib/field-merge.js uses that to
 * tell which fields changed here since a device's copy. The phone keeps the
 * same list (src/lib/db-native.js SYNC_FIELDS).
 */
export const SYNC_FIELDS = {
  recipe_categories: ['name', 'slug', 'color', 'sort_order'],
  pantry_categories: ['name', 'slug', 'icon', 'color', 'sort_order', 'default_aisle'],
  custom_units: ['abbr', 'full_name', 'category', 'sort_order'],
  cookbooks: ['name', 'slug', 'description', 'cover_image_url', 'is_smart', 'smart_filter_json', 'sort_order', 'deleted_at'],
  recipes: [
    'name', 'description', 'img_url', 'servings', 'prep_minutes', 'cook_minutes', 'total_minutes', 'rest_minutes',
    'ingredients', 'steps', 'tags', 'tools', 'source_url', 'video_url', 'notes',
    'visibility', 'rating', 'yield_text', 'last_cooked_at', 'cook_count',
    'nutrition', 'favorite', 'category_id', 'allergen_overrides', 'deleted_at',
  ],
  pantry_items: [
    'name', 'brand', 'barcode', 'in_stock', 'quantity', 'unit', 'expires_on',
    'nt_food_id', 'img_url', 'notes', 'category', 'category_id',
    'serving_size', 'serving_unit', 'serving_label', 'nutrition', 'g_per_cup',
    'generic_parent_id', 'nutrition_source_variant_id', 'allergens', 'traces', 'allergens_source', 'deleted_at',
  ],
  cook_diary: ['recipe_id', 'date', 'kind', 'servings', 'notes', 'photo_url', 'photos', 'meal_type', 'rating', 'any_day', 'recipe_rev', 'deleted_at'],
  shopping_list: ['name', 'quantity', 'unit', 'aisle', 'checked', 'pantry_id', 'recipe_id', 'sort_order', 'sources', 'notes', 'deleted_at'],
  recipe_comments: ['recipe_id', 'parent_id', 'body', 'deleted_at'],
  ai_chat_history: ['role', 'content'],
  // A recipe's versions (lib/recipe-content.js): made once, never changed
  // but for their name (label); only deleted, by hand.
  recipe_revisions: ['recipe_id', 'rev', 'data', 'label', 'deleted_at'],
};

/**
 * Fields whose meaning depends on each other, merged as one: an edit that
 * changed any of them competes with a change here to any of them, and the
 * one that stays brings the whole group. Merged one by one, a quantity from
 * one side and a unit from the other could make 3 g out of 2 lb and 500 g.
 * Fields not listed merge on their own.
 */
export const SYNC_GROUPS = {
  recipe_categories: [['name', 'slug']],
  pantry_categories: [['name', 'slug']],
  custom_units: [['abbr', 'full_name', 'category']],
  cookbooks: [['name', 'slug'], ['is_smart', 'smart_filter_json']],
  recipes: [
    // Steps point at ingredients by id; servings, yield and per-serving
    // nutrition go together; the total time can be worked out from the rest.
    ['ingredients', 'steps'],
    ['servings', 'yield_text', 'nutrition'],
    ['prep_minutes', 'cook_minutes', 'total_minutes', 'rest_minutes'],
  ],
  pantry_items: [
    ['quantity', 'unit'],
    ['serving_size', 'serving_unit', 'serving_label', 'nutrition', 'g_per_cup', 'nt_food_id'],
    ['category', 'category_id'],
    // Which item this is a variant of, and which variant its nutrition comes
    // from: the shape of the variant tree.
    ['generic_parent_id', 'nutrition_source_variant_id'],
    // What a label says, and that it's the label's (or the user's) word.
    ['allergens', 'traces', 'allergens_source'],
  ],
  // A cook's version belongs to its recipe.
  cook_diary: [['photos', 'photo_url'], ['date', 'meal_type', 'kind', 'any_day'], ['recipe_id', 'recipe_rev']],
  // An amount and where it came from (lib/shopping-plan.js) go together.
  shopping_list: [['quantity', 'unit', 'pantry_id', 'sources']],
  recipe_comments: [['recipe_id', 'parent_id']],
  ai_chat_history: [['role', 'content']],
  recipe_revisions: [['recipe_id', 'rev', 'data']],
};
