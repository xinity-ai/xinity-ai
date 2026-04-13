<script lang="ts">
	import "../app.css";
	import { setContext } from "svelte";
	// import favicon from "$lib/assets/favicon.svg";

	let { data, children } = $props();
	setContext("clientEnv", data.clientEnv);
</script>

<!-- <svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head> -->

{@render children()}
