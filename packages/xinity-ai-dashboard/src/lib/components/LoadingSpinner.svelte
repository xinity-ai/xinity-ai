<script lang="ts">
  export let label = "Loading...";
</script>

<div class="flex items-center space-x-2">
  <div aria-label={label} role="status">
    <svg
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      viewBox="0 0 24 24"
      stroke-linecap="round"
      stroke-linejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      class="{$$props.class || 'size-32 stroke-slate-500'} animate-spin"
    >
      <path
        d="M12 3v3m6.366-.366-2.12 2.12M21 12h-3m.366 6.366-2.12-2.12M12 21v-3m-6.366.366 2.12-2.12M3 12h3m-.366-6.366 2.12 2.12"
      />
    </svg>
  </div>
  <span class="text-5xl font-medium text-slate-500">{label}</span>
</div>
