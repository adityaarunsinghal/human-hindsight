/** Existing labels are grouped locally; explicit paths use " > " and at most five levels. */
export const MAX_DOMAIN_DEPTH = 5;
export const DOMAIN_ROOTS = [
  "Software engineering",
  "Data & AI",
  "Design",
  "Writing & research",
  "Business & operations",
  "Personal",
  "Other",
] as const;

const legacyGroups: { pattern: RegExp; path: string[] }[] = [
  {
    pattern: /\b(frontend|front.end|webapp|web app|react|css|html)\b/i,
    path: ["Software engineering", "Frontend"],
  },
  { pattern: /\b(backend|back.end|api|server)\b/i, path: ["Software engineering", "Backend"] },
  {
    pattern: /\b(devops|infrastructure|platform|deployment|release|ci\/cd|cloud)\b/i,
    path: ["Software engineering", "Infrastructure"],
  },
  {
    pattern: /\b(test|tests|testing|qa|quality assurance)\b/i,
    path: ["Software engineering", "Testing"],
  },
  {
    pattern: /\b(security|authentication|authorization)\b/i,
    path: ["Software engineering", "Security"],
  },
  {
    pattern: /\b(coding|software|programming|debugging|developer|cli|tooling)\b/i,
    path: ["Software engineering"],
  },
  { pattern: /\b(data|database|sql|machine learning|ai|llm|model)\b/i, path: ["Data & AI"] },
  { pattern: /\b(design|ux|ui|visual|accessibility)\b/i, path: ["Design"] },
  {
    pattern: /\b(documentation|writing|research|guide|editing|planning)\b/i,
    path: ["Writing & research"],
  },
  {
    pattern: /\b(business|marketing|finance|hiring|sales|operations)\b/i,
    path: ["Business & operations"],
  },
  { pattern: /\b(personal|travel|health|learning)\b/i, path: ["Personal"] },
];

export function domainPath(domain: string): string[] {
  const parts = domain
    .split(/\s*(?:>|→)\s*|\s+\/\s+/u)
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  if (!parts.length) return [];
  if (parts.length === 1) {
    const label = parts[0] ?? "";
    const root = DOMAIN_ROOTS.find((value) => value.toLowerCase() === label.toLowerCase());
    if (root) return [root];
    const group = legacyGroups.find(({ pattern }) => pattern.test(label))?.path ?? ["Other"];
    if (group.at(-1)?.toLowerCase() === label.toLowerCase()) return [...group];
    return [...group, label];
  }
  const root = DOMAIN_ROOTS.find((value) => value.toLowerCase() === parts[0]?.toLowerCase());
  if (root) parts[0] = root;
  if (parts.length > MAX_DOMAIN_DEPTH)
    return [...parts.slice(0, MAX_DOMAIN_DEPTH - 1), parts.slice(MAX_DOMAIN_DEPTH - 1).join(" / ")];
  return parts;
}

export function matchesDomain(domain: string, prefix: string): boolean {
  const selected = prefix.split(" > ");
  const path = domainPath(domain);
  return selected.every((part, index) => part.toLowerCase() === path[index]?.toLowerCase());
}
