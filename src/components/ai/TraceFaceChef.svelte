<!--
  TraceFaceChef — CookTrace-only flourish that wraps the shared
  TraceFace mascot with a chef-hat overlay. The TraceFace SVG itself
  stays untouched (mirrored across CookTrace / NutriTrace / LiftTrace
  per the brand-cohesion rule). The hat is layered as a second SVG in
  the same 56-unit viewBox so it scales 1:1 with the face's `size`.

  Silhouette goal: classic three-lobe toque — three rounded puffs at
  the top with deep V-notches between them, a flared skirt below, and
  a band with a horizontal groove at the base.
-->
<script>
  import TraceFace from './TraceFace.svelte';
  export let size = 42;
</script>

<div class="trace-face-chef" style="width:{size}px;height:{size}px">
  <!-- Shift the face down ~12% of the SVG height so the chef hat band
       sits cleanly above the eyes instead of crossing them. The hat
       SVG keeps its original coordinates; only the face slides. -->
  <div class="face-shift">
    <TraceFace {size} />
  </div>
  <svg class="chef-hat" viewBox="0 0 56 56" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <!-- Subtle vertical highlight on the puffs to give the hat a
           hint of dimension without going full chrome-shaded. -->
      <linearGradient id="hat-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"  stop-color="#ffffff"/>
        <stop offset="100%" stop-color="#e8eaef"/>
      </linearGradient>
    </defs>
    <g class="hat-group" stroke="#1f2742" stroke-width="1.2" stroke-linejoin="round">
      <!-- Skirt — the body below the puffs that flares out to the band.
           Drawn first so the puff circles overlap its top edge cleanly. -->
      <path class="hat-skirt"
        d="M14 19 Q14 14 18 13 L38 13 Q42 14 42 19 L42 22 L14 22 Z"
        fill="url(#hat-fill)"/>
      <!-- Three lobes. Left + right are smaller; middle sits highest
           and slightly larger, matching the canonical chef-toque shape. -->
      <circle class="hat-puff hat-puff-l" cx="18" cy="9"  r="6.5" fill="url(#hat-fill)"/>
      <circle class="hat-puff hat-puff-r" cx="38" cy="9"  r="6.5" fill="url(#hat-fill)"/>
      <circle class="hat-puff hat-puff-c" cx="28" cy="6"  r="7.5" fill="url(#hat-fill)"/>
      <!-- Band at the base + the horizontal groove line that gives the
           band its "two-strip" look in the reference. -->
      <rect  class="hat-band" x="12" y="22" width="32" height="5" rx="1.2"
        fill="#ffffff"/>
      <line  class="hat-band-groove" x1="13.5" y1="24.6" x2="42.5" y2="24.6"
        stroke="#1f2742" stroke-width="0.7" stroke-linecap="round"/>
    </g>
  </svg>
</div>

<style>
  .trace-face-chef {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
  }
  /* Translate the face down inside the wrapper so the chef-hat band
     clears the eyes. 12% of the wrapper height ≈ 6 SVG units, which
     pushes the eyes (originally y=24-30) safely below the band's
     bottom edge (y=27). */
  .face-shift {
    position: absolute;
    inset: 0;
    transform: translateY(12%);
  }
  /* Hat sits in its own SVG over the face's. Same viewBox keeps the
     two perfectly aligned at any size. The middle puff's top edge
     sits above the viewBox origin (cy=6 minus r=7.5 gives y=-1.5),
     so allow the SVG to render outside its own box, otherwise the
     browser's default `overflow: hidden` on <svg> clips the puff. */
  .chef-hat {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
    filter: drop-shadow(0 1.2px 1.6px rgba(0,0,0,0.28));
  }
  /* Whole hat does a tiny idle sway so it feels alive without
     bouncing the shape apart. */
  .hat-group {
    transform-origin: 28px 24px;
    animation: hat-sway 3.6s ease-in-out infinite;
  }
  @keyframes hat-sway {
    0%, 100% { transform: translateY(0)    rotate(0deg);   }
    50%       { transform: translateY(-0.4px) rotate(-0.6deg); }
  }
</style>
