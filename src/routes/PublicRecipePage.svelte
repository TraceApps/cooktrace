<script>
  /**
   * A public recipe link opened on its own (main.js mounts this instead of
   * the app): no sign-in, no local database, no sync. Just the recipe, and
   * the timer pill so its step timers can be seen and stopped.
   */
  import PublicRecipe from './PublicRecipe.svelte';
  import TopTimerPill from '../components/recipe/TopTimerPill.svelte';

  export let token;
</script>

<TopTimerPill />
<PublicRecipe params={{ token }} />
