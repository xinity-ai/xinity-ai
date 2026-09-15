ALTER TABLE "call_data"."audit_event" DROP CONSTRAINT "audit_event_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "call_data"."audit_event" ADD COLUMN "stream_position" bigint NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "call_data"."audit_event_stream_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);--> statement-breakpoint
CREATE UNIQUE INDEX "audit_event_stream_position_idx" ON "call_data"."audit_event" USING btree ("stream_position");