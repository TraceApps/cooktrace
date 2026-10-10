/**
 * What an app knows of the synced tables, as a number it sends with each
 * pull. An app writes every column it's sent into its own tables, so the
 * server sends a column or table added later only to apps that know it
 * (routes/sync.js LATER_COLS): 1, before 1.5 (none sent); 2, 1.5's (list
 * sources and notes, "any day" plans, allergens, recipe versions).
 */
export const SYNC_SCHEMA = 2;

/**
 * The fields of each synced table, as the server merges two edits of a row
 * (server/lib/sync-fields.js, kept the same by a test). The phone and the
 * web app both say which of them an edit changed.
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
