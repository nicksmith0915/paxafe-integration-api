/**
 * Tive webhook input contract, expressed as Zod.
 *
 * Mirrors `schemas/tive-incoming-schema.json`. Two deliberate departures from a
 * literal JSON-Schema translation:
 *
 *  1. Enum-typed strings from the provider (LocationMethod, SignalStrength,
 *     Estimation) are accepted as free strings. Rejecting a whole shipment's
 *     telemetry because Tive shipped a new location method would be the wrong
 *     failure mode; unknown values are normalised downstream and flagged.
 *  2. Optional numeric containers are `.nullish()` throughout -- the sample
 *     payloads show Tive sending both `null` and outright absence for the same
 *     field (e.g. `ProbeTemperature`, `Accuracy`).
 */

import { z } from 'zod';

const TemperatureReading = z.object({
  Celsius: z.number().nullish(),
  Fahrenheit: z.number().nullish(),
});

const TiveAccuracy = z.object({
  Meters: z.number().nullish(),
  Kilometers: z.number().nullish(),
  Miles: z.number().nullish(),
});

const TiveLocation = z.object({
  Latitude: z
    .number()
    .min(-90, 'Latitude must be between -90 and 90.')
    .max(90, 'Latitude must be between -90 and 90.'),
  Longitude: z
    .number()
    .min(-180, 'Longitude must be between -180 and 180.')
    .max(180, 'Longitude must be between -180 and 180.'),
  FormattedAddress: z.string().nullish(),
  LocationMethod: z.string().nullish(),
  Accuracy: TiveAccuracy.nullish(),
  GeolocationSourceName: z.string().nullish(),
  CellTowerUsedCount: z.number().int().nullish(),
  WifiAccessPointUsedCount: z.number().int().nullish(),
});

const TiveEndpoint = z.object({
  Latitude: z.number().nullish(),
  Longitude: z.number().nullish(),
  FormattedAddress: z.string().nullish(),
});

const TiveShipment = z.object({
  Id: z.string().nullish(),
  Description: z.string().nullish(),
  DeviceId: z.string().nullish(),
  ShipFrom: TiveEndpoint.nullish(),
  ShipTo: TiveEndpoint.nullish(),
  Carrier: z.string().nullish(),
});

export const TivePayloadSchema = z.object({
  // --- Required by the Tive contract ---
  /** 15-digit tracker IMEI. Becomes PX `device_imei`. */
  DeviceId: z
    .string()
    .regex(/^[0-9]{15}$/, 'DeviceId must be a 15-digit IMEI.'),
  /** Human-facing device name. Becomes PX `device_id`. */
  DeviceName: z.string().min(1),
  EntryTimeEpoch: z
    .number()
    .int('EntryTimeEpoch must be an integer number of milliseconds.')
    .min(0),
  Temperature: TemperatureReading,
  Location: TiveLocation,

  // --- Optional ---
  EntityName: z.string().nullish(),
  EntryTimeUtc: z.string().nullish(),
  Cellular: z
    .object({
      SignalStrength: z.string().nullish(),
      Dbm: z.number().nullish(),
    })
    .nullish(),
  ProbeTemperature: TemperatureReading.nullish(),
  Humidity: z.object({ Percentage: z.number().nullish() }).nullish(),
  Accelerometer: z
    .object({
      G: z.number().nullish(),
      X: z.number().nullish(),
      Y: z.number().nullish(),
      Z: z.number().nullish(),
    })
    .nullish(),
  Light: z.object({ Lux: z.number().nullish() }).nullish(),
  Battery: z
    .object({
      Percentage: z.number().int().min(0).max(100).nullish(),
      Estimation: z.string().nullish(),
      IsCharging: z.boolean().nullish(),
    })
    .nullish(),
  Shipment: TiveShipment.nullish(),
  AccountId: z.number().int().nullish(),
  ShipmentId: z.string().nullish(),
  PublicShipmentId: z.string().nullish(),
});

export type TivePayload = z.infer<typeof TivePayloadSchema>;
