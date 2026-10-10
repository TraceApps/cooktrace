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
    'nutrition', 'favorite', 'category_id', 'deleted_at',
  ],
  pantry_items: [
    'name', 'brand', 'barcode', 'in_stock', 'quantity', 'unit', 'expires_on',
    'nt_food_id', 'img_url', 'notes', 'category', 'category_id',
    'serving_size', 'serving_unit', 'serving_label', 'nutrition', 'g_per_cup',
    'generic_parent_id', 'nutrition_source_variant_id', 'deleted_at',
  ],
  cook_diary: ['recipe_id', 'date', 'kind', 'servings', 'notes', 'photo_url', 'photos', 'meal_type', 'rating', 'deleted_at'],
  shopping_list: ['name', 'quantity', 'unit', 'aisle', 'checked', 'pantry_id', 'recipe_id', 'sort_order', 'sources', 'deleted_at'],
  recipe_comments: ['recipe_id', 'parent_id', 'body', 'deleted_at'],
  ai_chat_history: ['role', 'content'],
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
  ],
  cook_diary: [['photos', 'photo_url'], ['date', 'meal_type', 'kind']],
  // An amount and where it came from (lib/shopping-plan.js) go together.
  shopping_list: [['quantity', 'unit', 'pantry_id', 'sources']],
  recipe_comments: [['recipe_id', 'parent_id']],
  ai_chat_history: [['role', 'content']],
};
