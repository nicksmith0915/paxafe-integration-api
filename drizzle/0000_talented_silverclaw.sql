CREATE TABLE "devices" (
	"device_imei" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"provider" text NOT NULL,
	"device_type" text NOT NULL,
	"account_id" integer,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_payload_id" uuid,
	"device_imei" text NOT NULL,
	"device_id" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"provider" text NOT NULL,
	"device_type" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"altitude" numeric(9, 2),
	"location_accuracy" integer,
	"location_accuracy_category" text,
	"location_source" text,
	"address" jsonb,
	"battery_level" integer,
	"cellular_dbm" numeric(6, 2),
	"cellular_network_type" text,
	"cellular_operator" text,
	"wifi_access_points" integer,
	"shipment_id" text,
	"data_quality_flags" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_payloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" text NOT NULL,
	"provider" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"body" jsonb NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"error_detail" jsonb,
	"device_imei" text,
	"recorded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sensor_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_payload_id" uuid,
	"device_imei" text NOT NULL,
	"device_id" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"provider" text NOT NULL,
	"device_type" text NOT NULL,
	"temperature" numeric(6, 2),
	"humidity" numeric(4, 1),
	"light_level" numeric(10, 1),
	"accel_x" numeric(7, 3),
	"accel_y" numeric(7, 3),
	"accel_z" numeric(7, 3),
	"accel_magnitude" numeric(7, 3),
	"tilt" jsonb,
	"box_open" boolean,
	"shipment_id" text,
	"data_quality_flags" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"shipment_id" text PRIMARY KEY NOT NULL,
	"public_shipment_id" text,
	"description" text,
	"carrier" text,
	"ship_from" jsonb,
	"ship_to" jsonb,
	"account_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "location_readings" ADD CONSTRAINT "location_readings_raw_payload_id_raw_payloads_id_fk" FOREIGN KEY ("raw_payload_id") REFERENCES "public"."raw_payloads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensor_readings" ADD CONSTRAINT "sensor_readings_raw_payload_id_raw_payloads_id_fk" FOREIGN KEY ("raw_payload_id") REFERENCES "public"."raw_payloads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devices_account_idx" ON "devices" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "location_readings_device_time_key" ON "location_readings" USING btree ("device_imei","recorded_at");--> statement-breakpoint
CREATE INDEX "location_readings_device_recent_idx" ON "location_readings" USING btree ("device_imei","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "location_readings_shipment_idx" ON "location_readings" USING btree ("shipment_id","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "raw_payloads_status_received_idx" ON "raw_payloads" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "raw_payloads_device_idx" ON "raw_payloads" USING btree ("device_imei","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sensor_readings_device_time_key" ON "sensor_readings" USING btree ("device_imei","recorded_at");--> statement-breakpoint
CREATE INDEX "sensor_readings_device_recent_idx" ON "sensor_readings" USING btree ("device_imei","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sensor_readings_shipment_idx" ON "sensor_readings" USING btree ("shipment_id","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "shipments_public_id_idx" ON "shipments" USING btree ("public_shipment_id");