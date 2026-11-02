// Suggested operator action per alert type (shown on the annunciator and alert detail).
const SUGGESTIONS: Record<string, string> = {
  // RTA
  availability:
    'Fewer than the minimum dishes are in service. Check the dish grid for faulted/disabled dishes, re-enable dishes back from maintenance and avoid stowing more.',
  wind_stow:
    'Wind stow is engaged. No action on the dishes; wait for the gust to stay below the release limit for 10 min, then resume paused scans.',
  dish_offline:
    'The dish stopped reporting or lost power. Check its power draw history; dispatch maintenance if it does not recover, and disable it so scans skip it.',
  dish_temperature:
    'Dish is overheating. Stop slews on it, consider stowing or disabling it, and check sunshine/irradiance and power draw.',
  dish_power: 'Power draw above the limit. Watch for a power fault; disable the dish before it goes offline.',
  dish_movement:
    'A slew timed out or the drive stalled. Retry a small azimuth/elevation adjustment; if it stalls again, disable the dish for maintenance.',
  dish_calibration: 'Calibration overdue or failed. Request a recalibration when the dish is not scanning.',
  dish_scan:
    'Dish is degrading the scan (low SNR, fault or no samples). Check its fault code; the image clean-up drops its bad samples. Recalibrate after the scan.',
  // LWM
  site_offline:
    'Site is not reporting. metadata.reason says battery, comms or no_samples: for battery lengthen the sample interval; for comms expect a backfill when the link returns.',
  high_wind: 'High wind at the site. Expect RTA wind stow; postpone technician visits and recalibration.',
  lightning_proximity:
    'Lightning within the limit. Technician visits are blocked; keep crews indoors until 30 min after the last strike.',
  storm_approach:
    'A storm is approaching. Consider the Storm watch preset (10 s sampling), OPG storm prep and pausing RTA scans.',
  extreme_temperature: 'Air temperature outside the limits. Check the reading against neighbouring sites before acting.',
  heavy_rain: 'Heavy rain. Expect lower solar output and possible pan overflow at lwm-5.',
  low_battery: 'Battery low. Lengthen the sample interval (Battery saver) or, for OPG, reduce load or start the generators.',
  sensor_fault:
    'A sensor reads out of range or is stuck (metadata.measurement / reason). Request a recalibration of the site.',
  calibration_overdue: 'Site calibration is overdue. Request a recalibration (not during high wind or backfill).',
  soiling: 'Reference cell is dirty. Schedule clean_reference_cell at lwm-4 (not while lightning is close).',
  pan_level: 'Evaporation pan level outside the limits. Refill the pan at lwm-5 if it is low.',
  // OPG
  supply_shortfall:
    'Load is not covered. Start the generators, enable load shedding and check solar/battery availability.',
  backup_active: 'Diesel generators are supplying power. Watch the fuel level and stop them once solar/battery recover.',
  solar_underperformance:
    'Solar output is below expected for the irradiance. Check inverter status and soiling; dust or a string failure is likely.',
  battery_temperature: 'Battery bank is hot. Reduce charge/discharge (generation priority) and watch battery health.',
  low_fuel: 'Fuel is low. Minimise generator use until the next refuel; plan load shedding.',
  generator_fault: 'Generator failed to start or tripped. Retry start_generator once; otherwise shed load and raise maintenance.',
  // platform
  service_offline: 'The service reported online=false (stopped or lost its broker). Check the service container and broker.',
  stream_silent:
    'Expected telemetry has not arrived for more than 3 periods. Check the entities listed in metadata and the service.',
  seq_gap: 'Messages were lost between the service and the platform. Check broker load and the network; data in the gap is missing.',
  broker_disconnected: 'The platform lost its MQTT broker connection. It reconnects automatically every second.',
  api_unreachable: 'The ARL API is unreachable. Researcher verification, targets and limits are unavailable until it returns.',
  ingestion_degraded:
    'The write queue overflowed; only raw messages are being stored. Reduce load or check disk I/O; replay still has raw data.',
};

export function suggestedAction(type: string): string {
  return SUGGESTIONS[type] ?? 'Review the alert value against its limit and the related entity, then acknowledge.';
}
