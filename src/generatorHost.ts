export const GENERATOR_HOST = "site.martitony.com";
export const GENERATOR_URL = "https://site.martitony.com";
export const MAIN_SITE_URL = "https://martitony.com";

export function isGeneratorHost(hostname: string) {
  return hostname === GENERATOR_HOST;
}
