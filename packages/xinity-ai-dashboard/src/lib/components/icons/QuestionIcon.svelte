<script>
  export let circled = false;
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  fill="none"
  viewBox="0 0 24 24"
  stroke-width="1.5"
  stroke="currentColor"
  class={$$props.class || "w-6 h-6"}
>
  <path
    stroke-linecap="round"
    stroke-linejoin="round"
    d="M9.879,7.519
    c1.171,-1.025,3.071,-1.025,4.242,0
    c1.172,1.025,1.172,2.687,0,3.712
    c-0.203,0.179,-0.43,0.326,-0.67,0.442
    c-0.745,0.361,-1.45,0.999,-1.45,1.827
    v0.75
    M21,12
    m-9,5.25
    h0.008
    v0.008
    H12
    v-0.008
    Z"
  />
  {#if circled}
    <circle r="10" cy="12" cx="12" />
  {/if}
</svg>
