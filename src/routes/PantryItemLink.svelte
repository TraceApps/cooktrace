<script>
  // #/pantry/<id>: an old link or bookmark, or "Open in Pantry" from the
  // shopping list. A pantry item lives in its sheet on the Pantry, so this
  // opens the Pantry with that sheet up (Pantry reads ?open=).
  import { onMount } from 'svelte';
  import { replace } from 'svelte-spa-router';
  export let params = {};
  onMount(() => {
    const id = parseInt(params?.id, 10);
    replace(Number.isInteger(id) && id > 0 ? `/pantry?open=${id}` : '/pantry');
  });
</script>
