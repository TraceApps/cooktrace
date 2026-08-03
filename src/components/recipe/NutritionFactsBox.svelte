<script>
  /**
   * NutritionFactsBox — FDA-style "Nutrition Facts" label.
   *
   * Layout matches the standard FDA "Nutrition Facts" panel: huge
   * "Nutrition Facts" title, serving info, thick rule, prominent
   * Calories row, % Daily Value column, indented sub-nutrients,
   * a thick rule before the vitamin/mineral block, and the small
   * footnote at the bottom.
   *
   * Props:
   *   nutrition           — { calories, fat, ..., _derived: {...} }
   *   servings            — recipe servings count (recipe context)
   *   yieldText           — recipe yield text (kept for compatibility;
   *                         no longer rendered in the serving-size line)
   *   recipeMassG         — total grams per serving, computed by
   *                         computeRecipeMass() in recipe-nutrition.js.
   *                         When set, the serving-size line shows
   *                         "~{recipeMassG}g". Null means the recipe
   *                         has at least one ingredient without
   *                         convertible mass data, so we don't fake it.
   *   servingDescription  — pantry override: "100 g" / "1 cup, sifted".
   *                         When set, takes precedence over recipe vars.
   *   servingsPerContainer — optional packaged-food line (pantry only).
   *   forceShowAll        — when true, render every nutriment that has a
   *                         non-trivial value, IGNORING the user's
   *                         visibleNutriments preference. Mirrored from
   *                         NutriTrace's copy where Trace's AI proposal
   *                         cards use it to dump the full estimated
   *                         profile regardless of the daily-view subset.
   *                         Not currently called with true from any
   *                         CookTrace surface, but kept in sync so the
   *                         shared component stays byte-for-byte.
   */
  import { _ } from 'svelte-i18n';
  import {
    NUTRIMENTS, DEFAULT_VISIBLE_NUTRIMENT_IDS,
    dvPercent, isDerived,
    displayEnergy, energyLabel, energyUnitSuffix,
  } from '../../lib/nutriments.js';
  import { visibleNutriments, energyUnit } from '../../stores/settings.js';

  export let nutrition = {};
  export let servings = null;
  export let yieldText = '';
  export let recipeMassG = null;
  export let servingDescription = '';
  export let servingsPerContainer = null;
  export let forceShowAll = false;

  // yieldText is intentionally unused in the rendered serving line now —
  // the recipe header already prints the yield prominently, and mixing
  // it into "1 of N (yield)" produced a confusing double-unit line
  // ("1 of 8 (Arancine Dolci)"). Kept as a prop so existing callers
  // don't have to drop it; reference here silences the unused-export
  // warning without changing behavior.
  void yieldText;

  // Effective visible-set: user choice if any, else the default subset.
  // Bypassed entirely when forceShowAll is on.
  $: visibleSet = new Set(
    Array.isArray($visibleNutriments) && $visibleNutriments.length > 0
      ? $visibleNutriments
      : DEFAULT_VISIBLE_NUTRIMENT_IDS
  );

  // Filter to nutriments that have a value present AND (are user-visible
  // OR forceShowAll is on).
  $: rows = NUTRIMENTS.filter(n => {
    if (!forceShowAll && !visibleSet.has(n.id)) return false;
    const v = nutrition?.[n.id];
    return v != null && v !== '' && Number(v) >= 0 &&
      // Only include zero-valued rows for the canonical FDA-required
      // nutrients — otherwise a pantry item filling everything to 0
      // would render every nutrient as "0g".
      (Number(v) > 0 || n.fdaRequired);
  });

  // Calories gets the prominent display.
  $: caloriesNut = rows.find(r => r.id === 'calories');
  $: caloriesValDisplay = caloriesNut
    ? displayEnergy(nutrition[caloriesNut.id], $energyUnit) : null;
  $: caloriesUnitLabel = energyUnitSuffix($energyUnit);
  $: caloriesRowLabel = energyLabel($energyUnit);
  $: bodyRows = rows.filter(r => r.id !== 'calories');

  // FDA panel layout: fdaBlock='macros' renders above the thick rule
  // (fat group, cholesterol, sodium, carb group, protein) and
  // fdaBlock='micros' renders below (vitamin + mineral DV section).
  // This is intentionally distinct from `category` because sodium is
  // biochemically a mineral but lives in the macros block on the real
  // FDA label. Rows without fdaBlock (kilojoules, salt) are derived
  // and never rendered as their own line.
  $: macroRows  = bodyRows.filter(r => r.fdaBlock === 'macros');
  $: vitMinRows = bodyRows.filter(r => r.fdaBlock === 'micros');

  function fmt(v, unit) {
    if (v == null) return '';
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    // Whole when close enough; otherwise 1 decimal max. No space
    // between number and unit (matches FDA: "0g", "15mg").
    const text = Math.abs(n - Math.round(n)) < 0.05
      ? String(Math.round(n))
      : n.toFixed(1).replace(/\.0$/, '');
    return text + (unit || '');
  }
  function _depth(n) {
    // 0 = top-level, 1 = sub (Saturated Fat, Dietary Fiber), 2 = sub-sub
    // (Includes Added Sugars). NUTRIMENTS may chain via subOf.
    let d = 0;
    let cur = n;
    while (cur?.subOf) {
      d++;
      cur = NUTRIMENTS.find(x => x.id === cur.subOf);
      if (!cur || d > 3) break;
    }
    return d;
  }
</script>

{#if rows.length > 0}
<div class="nfacts">
  <div class="title">{$_('nutrition_facts.title')}</div>

  {#if servingsPerContainer}
    <div class="serving-line">{servingsPerContainer} servings per container</div>
  {:else if !servingDescription && servings}
    <!-- Recipe context: mirror the packaged-food "Servings per
         container: N" line with the recipe-flavored equivalent so the
         label still answers both questions ("how big is this whole
         thing?" + "what does one portion equal?"). -->
    <div class="serving-line">Servings Per Recipe: {servings}</div>
  {/if}
  <div class="serving-line">
    <strong>{$_('nutrition_facts.serving_size')}</strong>
    <span class="serving-detail">
      {#if servingDescription}
        {servingDescription}
      {:else if recipeMassG}
        ~{recipeMassG}g
      {:else if servings}
        1 of {servings}
      {:else}
        Per serving
      {/if}
    </span>
  </div>

  <div class="rule thick"></div>

  {#if caloriesNut}
    <div class="amount-label">{$_('nutrition_facts.amount_per_serving')}</div>
    <div class="cal-row">
      <span class="cal-name">{caloriesRowLabel}</span>
      <span class="cal-value">
        {caloriesValDisplay}{#if $energyUnit === 'kJ'}<span class="cal-unit"> {caloriesUnitLabel}</span>{/if}
      </span>
    </div>
    <div class="rule mid"></div>
  {/if}

  <div class="dv-header">% Daily Value*</div>

  {#each macroRows as nut (nut.id)}
    {@const v = nutrition[nut.id]}
    {@const dv = dvPercent(nut, v)}
    {@const depth = _depth(nut)}
    {@const derived = isDerived(nutrition, nut.id)}
    <div class="row" class:bold={nut.bold && depth === 0} class:italic={nut.italic}
      style={depth > 0 ? `padding-left:${depth * 14}px` : ''}>
      <span class="row-label">
        {#if nut.id === 'added-sugars'}
          <!-- FDA format: "Includes <qty> Added Sugars". Qty is
               embedded between "Includes" and the label. -->
          <span class="row-name">Includes {fmt(v, nut.unit)} {nut.label}</span>
        {:else}
          <span class="row-name">{nut.label}</span>
          <span class="row-value">{fmt(v, nut.unit)}</span>
        {/if}
        {#if derived}
          <span class="derived material-symbols-rounded"
            title="Derived from {nut.id === 'sodium' ? 'salt' : 'sodium'}">calculate</span>
        {/if}
      </span>
      <span class="row-dv">{dv != null ? `${dv}%` : ''}</span>
    </div>
  {/each}

  {#if vitMinRows.length > 0}
    <div class="rule thick"></div>
    {#each vitMinRows as nut, i (nut.id)}
      {@const v = nutrition[nut.id]}
      {@const dv = dvPercent(nut, v)}
      <div class="row vmin" class:no-bottom={i === vitMinRows.length - 1}>
        <span class="row-label">
          <span class="row-name">{nut.label}</span>
          <span class="row-value">{fmt(v, nut.unit)}</span>
        </span>
        <span class="row-dv">{dv != null ? `${dv}%` : ''}</span>
      </div>
    {/each}
  {/if}

  <div class="rule thick"></div>
  <p class="footnote">
    * The % Daily Value (DV) tells you how much a nutrient in a serving
    of food contributes to a daily diet. 2,000 calories a day is used
    for general nutrition advice.
  </p>
</div>
{/if}

<style>
  /* Black-on-white FDA Nutrition Facts label, sized to fit nicely
     inside a recipe / pantry detail card. Color is intentionally
     fixed to black/white so it reads as the official label even in
     dark mode. */
  .nfacts {
    background: #ffffff;
    color: #000000;
    border: 2px solid #000;
    padding: 8px 12px 12px;
    border-radius: 4px;
    max-width: 380px;
    width: 100%;
    box-sizing: border-box;
    font-family: 'Helvetica Neue', 'Arial Black', Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.2;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  }

  /* "Nutrition Facts" — extra-bold, no underline. The thick separator
     comes after the serving lines, not under the title. */
  .title {
    font-size: 32px;
    font-weight: 900;
    line-height: 1.0;
    letter-spacing: -0.01em;
    padding: 4px 0 6px;
  }

  .serving-line {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    align-items: baseline;
    font-size: 15px;
    line-height: 1.25;
    padding: 1px 0;
  }
  .serving-line strong { font-weight: 700; }
  .serving-detail { font-weight: 700; text-align: right; }

  /* Rules */
  .rule { border-top: 1px solid #000; margin: 4px -12px; }
  .rule.thick { border-top-width: 10px; }
  .rule.mid   { border-top-width: 5px; }

  .amount-label {
    font-size: 11px;
    font-weight: 700;
    padding-top: 4px;
  }

  /* Calories row — name big-bold left, number HUGE bold right */
  .cal-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 0 0 4px;
  }
  .cal-name  { font-size: 26px; font-weight: 900; line-height: 1; }
  .cal-value { font-size: 38px; font-weight: 900; line-height: 1; }
  .cal-unit  { font-size: 14px; font-weight: 700; }

  .dv-header {
    text-align: right;
    font-size: 12px;
    font-weight: 700;
    border-bottom: 1px solid #000;
    padding: 2px 0 2px;
    margin-bottom: 0;
  }

  .row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    border-bottom: 1px solid #000;
    padding: 4px 0;
    font-size: 14px;
  }
  .row.italic { font-style: italic; }
  /* gap of 4px keeps "Total Fat" and "10g" visually separated. The
     value span had a leading space character but inline-flex
     collapses whitespace between flex items, so use gap instead. */
  .row-label  { display: inline-flex; align-items: baseline; gap: 4px; flex: 1; min-width: 0; }
  .row-name   { font-weight: 700; }
  /* Bold flag is on TOP-LEVEL macro rows ("Total Fat", "Cholesterol",
     "Sodium", "Total Carbohydrate", "Protein"). Sub-rows
     (Saturated Fat, Trans Fat, Dietary Fiber, ...) keep names regular. */
  .row:not(.bold) .row-name { font-weight: 400; }
  /* "Total Fat" etc. — when a row is bold, the NAME is bold but the
     value stays regular weight, exactly like the printed label. */
  .row.bold .row-name { font-weight: 700; }
  .row-value { font-weight: 400; }
  .row-dv {
    font-weight: 700;
    min-width: 44px;
    text-align: right;
    flex-shrink: 0;
  }

  /* Vitamins / minerals: smaller, name not bold, DV% bold. */
  .row.vmin {
    font-size: 13px;
    padding: 3px 0;
  }
  .row.vmin .row-name { font-weight: 400; }
  .row.vmin.no-bottom { border-bottom: none; }

  .derived {
    font-size: 13px;
    color: #555;
    margin-left: 3px;
    cursor: help;
  }

  .footnote {
    font-size: 10.5px;
    line-height: 1.35;
    margin: 6px 0 0;
    font-weight: 400;
  }
</style>
