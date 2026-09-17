import { load as parseYaml } from "js-yaml";

/**
 * Parses a Spring-style application.yml/yaml for service URL references,
 * e.g.:
 *   train-service:
 *     url: http://${TRAIN_SERVICE_HOST:ts-train-service}:${TRAIN_SERVICE_PORT:14567}
 *   datasource:
 *     url: jdbc:mysql://${TRAVEL_MYSQL_HOST:ts-travel-mysql}:3306/db
 *
 * Generic on purpose: walks the whole parsed YAML tree and pulls the host
 * out of any string value that looks like a "scheme://host[:port]" URL,
 * whether the host is a literal or a Spring `${VAR:default}` placeholder
 * (the default is what actually resolves at runtime when the env var
 * isn't set, which is the common case in a docker-compose deployment).
 * Not specific to any one key name ("url", "server-addr", etc.) or to any
 * one project — the caller decides what to do with the extracted hostname
 * (e.g. only keep it if it matches a real discovered service).
 */
export interface ApplicationConfigReference {
  /** Dotted path to the value in the YAML tree, e.g. "train-service.url" — for evidence/logging. */
  yamlPath: string;
  /** The hostname extracted from the URL (literal, or the placeholder's default). */
  targetHostname: string;
  /** The raw string value it was extracted from, for evidence/logging. */
  rawValue: string;
}

const URL_HOST_PATTERN = /:\/\/(?:\$\{[A-Za-z0-9_]+:([a-zA-Z0-9_.-]+)\}|([a-zA-Z0-9_.-]+))/;

function extractHost(value: string): string | null {
  const match = value.match(URL_HOST_PATTERN);
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}

export function parseApplicationConfigDependencies(yamlContent: string): ApplicationConfigReference[] {
  try {
    const doc = parseYaml(yamlContent);
    const results: ApplicationConfigReference[] = [];

    const walk = (node: unknown, path: string[]): void => {
      if (typeof node === "string") {
        const host = extractHost(node);
        if (host) {
          results.push({ yamlPath: path.join("."), targetHostname: host, rawValue: node });
        }
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, [...path, String(i)]));
        return;
      }
      if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          walk(value, [...path, key]);
        }
      }
    };

    walk(doc, []);
    return results;
  } catch {
    return [];
  }
}
