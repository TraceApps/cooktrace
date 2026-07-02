/**
 * server/lib/heuristic-recipe-parser.js
 *
 * Rule-based recipe parser. Takes a chunk of plain text (a recipe written
 * in normal prose, the output of pdf-parse / RTF strip / a TXT or MD file)
 * and tries to produce a structured recipe without calling an LLM.
 *
 * This is the "built-in" half of the hybrid file-import pipeline (Issue #2).
 * When the heuristic returns a low confidence score, the caller can route
 * the same text through the AI assistant as a fallback.
 *
 * Output shape matches what `_saveImportedRecipe` already accepts in
 * server/routes/recipes.js, so the result can be persisted with no extra
 * normalization step.
 */
import { parseIngredientLine } from './recipe-scraper.js';

const INGREDIENT_HEADERS = [
  'ingredients', 'ingredient list', 'what you need', 'what you\'ll need',
  'shopping list', 'you will need',
];
const STEP_HEADERS = [
  'directions', 'instructions', 'method', 'steps', 'preparation', 'how to make',
  'how to prepare', 'procedure', 'cooking instructions', 'process',
];
const NOTES_HEADERS = [
  'notes', 'tips', 'chef notes', 'cook\'s notes', 'tips & tricks', 'tips and tricks',
];
const META_PATTERNS = [
  { key: 'servings',     re: /^(?:serves|servings?|yields?|makes)[:\s]+(.+?)$/i, kind: 'servings' },
  { key: 'prep',         re: /^(?:prep(?:aration)?\s*time)[:\s]+(.+?)$/i,         kind: 'minutes' },
  { key: 'cook',         re: /^(?:cook(?:ing)?\s*time|bake\s*time)[:\s]+(.+?)$/i, kind: 'minutes' },
  { key: 'rest',         re: /^(?:rest(?:ing)?\s*time|rise\s*time|proof(?:ing)?\s*time|chill(?:ing)?\s*time|marinat(?:e|ing)\s*time|soak(?:ing)?\s*time|inactive\s*time|wait(?:ing)?\s*time)[:\s]+(.+?)$/i, kind: 'minutes' },
  { key: 'total',        re: /^(?:total\s*time|ready\s*in)[:\s]+(.+?)$/i,          kind: 'minutes' },
];

/**
 * Parse a recipe text blob into a structured recipe.
 *
 * Returns { recipe, confidence, debug } where:
 *   recipe.name, ingredients[], steps[], servings, prep_minutes, cook_minutes, notes
 *   confidence: 0..1 score for how cleanly the text mapped to the recipe shape
 *   debug: lightweight diagnostic info (section starts, ingredient/step counts)
 */
export function parseRecipeText(text, opts = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    return { recipe: _stubRecipe(opts.fallbackName), confidence: 0, debug: { reason: 'empty input' } };
  }
  const lines = _normalizeLines(text);
  if (lines.length === 0) {
    return { recipe: _stubRecipe(opts.fallbackName), confidence: 0, debug: { reason: 'no lines' } };
  }

  const sections = _findSections(lines);
  const title = _extractTitle(lines, sections, opts.fallbackName);
  const meta = _extractMeta(lines);

  const ingredients = _extractIngredients(lines, sections);
  const steps = _extractSteps(lines, sections);
  const notes = _extractNotes(lines, sections);

  const confidence = _scoreConfidence({
    foundIngredientSection: sections.ingredientsStart >= 0,
    foundStepsSection:      sections.stepsStart      >= 0,
    parsedIngredients:      ingredients.length,
    parsedSteps:            steps.length,
    cleanIngredientCount:   ingredients.filter(i => i.qty || i.unit).length,
  });

  return {
    recipe: {
      name: title,
      description: null,
      imgUrl: null,
      servings: meta.servings ?? null,
      yield_text: meta.yield_text ?? null,
      prep_minutes:  meta.prep  ?? null,
      cook_minutes:  meta.cook  ?? null,
      rest_minutes:  meta.rest  ?? null,
      total_minutes: meta.total ?? null,
      ingredients,
      steps,
      tags: [],
      tools: [],
      nutrition: {},
      source_url: null,
      notes: notes || null,
      category_name: null,
    },
    confidence,
    debug: {
      lineCount: lines.length,
      sections,
      ingredientCount: ingredients.length,
      stepCount: steps.length,
    },
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function _stubRecipe(fallbackName) {
  return {
    name: fallbackName || 'Imported recipe',
    description: null,
    imgUrl: null,
    servings: null,
    yield_text: null,
    prep_minutes:  null,
    cook_minutes:  null,
    rest_minutes:  null,
    total_minutes: null,
    ingredients: [],
    steps: [],
    tags: [],
    tools: [],
    nutrition: {},
    source_url: null,
    notes: null,
    category_name: null,
  };
}

function _normalizeLines(text) {
  // Strip BOMs, collapse Windows newlines, split, trim, drop blank-only lines
  // at the very edges but keep internal blanks for section detection.
  const cleaned = String(text)
    .replace(/﻿/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const all = cleaned.split('\n').map(s => s.replace(/\s+$/, ''));
  // Drop leading + trailing blank lines.
  while (all.length && !all[0].trim()) all.shift();
  while (all.length && !all[all.length - 1].trim()) all.pop();
  return all;
}

function _isSectionHeader(line, headerList) {
  const trimmed = line.trim().toLowerCase().replace(/[:.\-–—]+\s*$/, '');
  if (!trimmed) return false;
  if (trimmed.length > 40) return false;  // headers are short
  return headerList.includes(trimmed);
}

function _findSections(lines) {
  let ingredientsStart = -1;
  let stepsStart = -1;
  let notesStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ingredientsStart < 0 && _isSectionHeader(ln, INGREDIENT_HEADERS)) {
      ingredientsStart = i;
    } else if (stepsStart < 0 && _isSectionHeader(ln, STEP_HEADERS)) {
      stepsStart = i;
    } else if (notesStart < 0 && _isSectionHeader(ln, NOTES_HEADERS)) {
      notesStart = i;
    }
  }
  return { ingredientsStart, stepsStart, notesStart };
}

function _extractTitle(lines, sections, fallback) {
  // Title is usually the first non-blank line, IF it's short and not a section
  // header and not a metadata line. Skip lines that are obviously not the title.
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const ln = lines[i].trim();
    if (!ln) continue;
    if (ln.length > 100) continue;
    if (_isSectionHeader(ln, [...INGREDIENT_HEADERS, ...STEP_HEADERS, ...NOTES_HEADERS])) continue;
    if (META_PATTERNS.some(p => p.re.test(ln))) continue;
    // Strip a leading markdown heading marker if present.
    return ln.replace(/^#+\s*/, '').trim();
  }
  return fallback || 'Imported recipe';
}

function _extractMeta(lines) {
  const meta = {};
  for (const ln of lines) {
    for (const p of META_PATTERNS) {
      const m = ln.match(p.re);
      if (!m) continue;
      const val = m[1].trim();
      if (p.kind === 'servings') {
        // "4", "Serves 4", "4-6 servings": grab the first integer.
        const n = val.match(/(\d+)/);
        if (n) {
          meta.servings = parseInt(n[1], 10);
          meta.yield_text = val;
        }
      } else if (p.kind === 'minutes') {
        const minutes = _parseMinutes(val);
        if (minutes != null) {
          if (p.key === 'prep')  meta.prep  = minutes;
          if (p.key === 'cook')  meta.cook  = minutes;
          if (p.key === 'rest')  meta.rest  = minutes;
          if (p.key === 'total') meta.total = minutes;
        }
      }
    }
  }
  return meta;
}

function _parseMinutes(s) {
  // Handles "1 hour 30 minutes", "45 min", "1.5 hr", "90", etc.
  const str = String(s).toLowerCase();
  const hourMatch = str.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/);
  const minMatch  = str.match(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/);
  let total = 0;
  if (hourMatch) total += Math.round(parseFloat(hourMatch[1]) * 60);
  if (minMatch)  total += Math.round(parseFloat(minMatch[1]));
  if (!hourMatch && !minMatch) {
    // Bare number: assume minutes.
    const bare = str.match(/(\d+)/);
    if (bare) total = parseInt(bare[1], 10);
  }
  return total > 0 ? total : null;
}

function _extractIngredients(lines, sections) {
  // If we found an "Ingredients" header, take lines from there up to the next
  // recognized section header. Otherwise, fall back to "lines that look like
  // ingredients" anywhere in the document (less reliable).
  let startIdx, endIdx;
  if (sections.ingredientsStart >= 0) {
    startIdx = sections.ingredientsStart + 1;
    endIdx = _nextSectionAfter(sections.ingredientsStart, sections, lines.length);
  } else {
    startIdx = 0;
    endIdx = lines.length;
  }

  const items = [];
  for (let i = startIdx; i < endIdx; i++) {
    const raw = lines[i];
    if (!raw || !raw.trim()) continue;
    // Skip if this line is the title (already captured) and we're scanning
    // the whole document because no Ingredients header was found.
    if (sections.ingredientsStart < 0 && i === 0) continue;
    // Skip bare metadata lines.
    if (META_PATTERNS.some(p => p.re.test(raw.trim()))) continue;
    // Skip section sub-headers like "For the sauce:".
    if (/^For (?:the )?[a-z][a-z\s]*:?$/i.test(raw.trim()) && raw.trim().length < 40) continue;
    // Skip lines that look like steps (start with a number followed by period
    // or a long sentence with multiple periods). We're inside the ingredients
    // block here, so steps shouldn't appear, but defensive.
    const cleaned = raw
      .replace(/^[•·\-\*•\s]+/, '')   // bullet markers
      .replace(/^\d+\.\s+/, '')             // "1. flour"
      .replace(/^\d+\)\s+/, '')             // "1) flour"
      .trim();
    if (!cleaned) continue;
    if (cleaned.length > 200) continue;     // probably not an ingredient line
    // If we're in fallback mode (no ingredients header), require something
    // that vaguely looks like a quantity to avoid grabbing every line.
    if (sections.ingredientsStart < 0 && !/^\s*(?:\d|½|⅓|⅔|¼|¾|a\s|an\s|one\s|two\s|three\s)/i.test(cleaned)) {
      continue;
    }
    const parsed = parseIngredientLine(cleaned);
    if (parsed.name) items.push(parsed);
  }
  return items;
}

function _extractSteps(lines, sections) {
  let startIdx, endIdx;
  if (sections.stepsStart >= 0) {
    startIdx = sections.stepsStart + 1;
    endIdx = _nextSectionAfter(sections.stepsStart, sections, lines.length);
  } else {
    // No explicit steps section. If ingredients section was found, take
    // everything after it that isn't notes.
    if (sections.ingredientsStart >= 0) {
      const ingEnd = _nextSectionAfter(sections.ingredientsStart, sections, lines.length);
      startIdx = ingEnd;
      endIdx = sections.notesStart >= 0 ? sections.notesStart : lines.length;
    } else {
      return [];
    }
  }

  const steps = [];
  let currentText = '';

  const flush = () => {
    const cleaned = currentText.replace(/\s+/g, ' ').trim();
    if (cleaned) steps.push({ title: '', text: cleaned });
    currentText = '';
  };

  for (let i = startIdx; i < endIdx; i++) {
    const raw = lines[i];
    if (!raw || !raw.trim()) {
      // Blank line ends the current step.
      if (currentText) flush();
      continue;
    }
    const trimmed = raw.trim();
    // Skip section sub-headers.
    if (/^For (?:the )?[a-z][a-z\s]*:?$/i.test(trimmed) && trimmed.length < 40) continue;
    // A leading numbered marker starts a new step.
    const numbered = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
    if (numbered) {
      if (currentText) flush();
      currentText = numbered[2];
      continue;
    }
    // Strip bullet markers for the first line of a new step.
    const cleanedLine = currentText
      ? trimmed
      : trimmed.replace(/^[•·\-\*•\s]+/, '');
    if (!currentText) {
      currentText = cleanedLine;
    } else {
      currentText += ' ' + cleanedLine;
    }
  }
  if (currentText) flush();
  return steps;
}

function _extractNotes(lines, sections) {
  if (sections.notesStart < 0) return null;
  const startIdx = sections.notesStart + 1;
  const endIdx = lines.length;
  const collected = lines.slice(startIdx, endIdx)
    .map(s => s.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  return collected || null;
}

function _nextSectionAfter(idx, sections, end) {
  const candidates = [sections.ingredientsStart, sections.stepsStart, sections.notesStart]
    .filter(n => n > idx);
  return candidates.length ? Math.min(...candidates) : end;
}

function _scoreConfidence(signals) {
  let score = 0;
  if (signals.foundIngredientSection) score += 0.40;
  if (signals.foundStepsSection)      score += 0.30;
  if (signals.parsedIngredients >= 3) score += 0.15;
  else if (signals.parsedIngredients >= 1) score += 0.05;
  if (signals.parsedSteps >= 2)       score += 0.10;
  else if (signals.parsedSteps >= 1)  score += 0.03;
  if (signals.cleanIngredientCount >= 3 && signals.parsedIngredients > 0) {
    // Boost when most ingredients have a real qty/unit (not just names).
    const ratio = signals.cleanIngredientCount / signals.parsedIngredients;
    if (ratio >= 0.5) score += 0.05;
  }
  return Math.min(1, Math.max(0, score));
}

/**
 * Confidence threshold above which the heuristic result is considered
 * good enough to skip the AI fallback.
 *
 * Tuned so a recipe with both clear section headers + 3+ parsed ingredients
 * + 2+ parsed steps lands above 0.7 and shows up as "clean".
 */
export const HIGH_CONFIDENCE_THRESHOLD = 0.7;
