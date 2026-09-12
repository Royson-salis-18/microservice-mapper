export interface ObservationTarget {
  id: string;
  name: string;
  project: string;
  environment: string;
  host: string;
  dockerSocket?: string;
  telemetryEndpoints?: string[];
}
