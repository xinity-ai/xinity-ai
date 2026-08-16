// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			request: Request;
			traceId: string;
			clientAddress: string;
			auditChannel: import("$lib/server/orpc/audit").AuditChannel;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export { };
