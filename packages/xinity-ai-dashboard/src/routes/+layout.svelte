<script lang="ts">
	import "../app.css";
	import { setContext } from "svelte";

	let { data, children } = $props();
	// clientEnv is set once on the server and never changes for a session, so a
	// non-reactive snapshot at mount time is what we want.
	// svelte-ignore state_referenced_locally
	setContext("clientEnv", data.clientEnv);
</script>

{@render children()}
