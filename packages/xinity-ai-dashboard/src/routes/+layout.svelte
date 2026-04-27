<script lang="ts">
	import "../app.css";
	import { setContext } from "svelte";
	// import favicon from "$lib/assets/favicon.svg";

	let { data, children } = $props();
	// clientEnv is set once on the server and never changes for a session, so a
	// non-reactive snapshot at mount time is what we want.
	// svelte-ignore state_referenced_locally
	setContext("clientEnv", data.clientEnv);
</script>

<!-- <svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head> -->

{@render children()}
