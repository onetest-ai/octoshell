import data from "./providers.json" with { type: "json" };

export interface ProviderCapability {
  id: string; // matches the daemon/discovery provider id AND the icon filename
  label: string;
  defaultEnabled: boolean;
}

export const CURATED_PROVIDERS: ProviderCapability[] = data as ProviderCapability[];
