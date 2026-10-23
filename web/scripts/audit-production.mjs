import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Advisories with no patched release that reach production only through
// WalletConnect/Reown or Coinbase. Each is allowed by its advisory id at the
// severity it was audited at, and only when every production package that
// depends on the finding sits under a path in `through`.
const ADVISORY_EXCEPTIONS = new Map([
  // zod GHSA-mrhx-c7xc-m3w5 has no patched 3.x (3.25.76 is the last). Production
  // reaches the zod 3 copies only through @reown/appkit-wallet and @coinbase/cdp-sdk;
  // as of 2026-10-23 the latest @reown/appkit-wallet (1.8.24) still pins zod 3.22.4
  // and @coinbase/cdp-sdk 1.60.0 needs zod ^3.25.76. Every zod 4 copy is overridden
  // to 4.6.7. This entry goes when upstream ships a patched release.
  ["https://github.com/advisories/GHSA-mrhx-c7xc-m3w5", {
    severity: "high",
    through: ["node_modules/@reown/appkit-wallet", "node_modules/@coinbase/cdp-sdk"],
    note: "zod GHSA-mrhx-c7xc-m3w5, whose zod 3 copies production reaches only through @reown/appkit-wallet and @coinbase/cdp-sdk",
  }],
]);

const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8"));

const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
  encoding: "utf8",
  env: process.env,
});

// npm uses exit 1 for vulnerability findings as well as operational failures.
// Only a complete report can distinguish those; an error JSON is never clean.
if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) {
  console.error("Production audit could not run to completion. No audit result was verified.");
  process.exit(1);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  process.stderr.write(
    result.stderr || result.stdout || "npm audit returned no JSON.\n",
  );
  process.exit(1);
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const severities = ["info", "low", "moderate", "high", "critical"];
const vulnerabilities = report?.vulnerabilities;
const counts = report?.metadata?.vulnerabilities;
if (
  !isRecord(report) || Object.hasOwn(report, "error") || report.auditReportVersion !== 2 ||
  !isRecord(vulnerabilities) || !isRecord(counts) ||
  ![...severities, "total"].every((severity) => Number.isInteger(counts[severity]) && counts[severity] >= 0) ||
  Object.values(vulnerabilities).some((vulnerability) =>
    !isRecord(vulnerability) || !severities.includes(vulnerability.severity) || !Array.isArray(vulnerability.via) ||
    vulnerability.via.some((via) => typeof via !== "string" &&
      (!isRecord(via) || typeof via.url !== "string" || !severities.includes(via.severity)))) ||
  counts.total !== Object.keys(vulnerabilities).length ||
  severities.some((severity) => counts[severity] !==
    Object.values(vulnerabilities).filter((vulnerability) => vulnerability.severity === severity).length) ||
  (result.status === 1 && counts.total === 0)
) {
  console.error("npm audit did not return a complete, consistent vulnerability report. No audit result was verified.");
  process.exit(1);
}

const rank = (severity) => severities.indexOf(severity);
// The production packages in the lockfile that depend on the installed copy at
// `node`, where an optional peer dependency is not a dependency.
const dependentsOf = (node) => {
  const name = node.slice(node.lastIndexOf("node_modules/") + "node_modules/".length);
  return Object.entries(lockfile.packages ?? {}).filter(([path, entry]) => {
    if (entry.dev) return false;
    const depends = ["dependencies", "optionalDependencies", "peerDependencies"].some(
      (field) => Object.hasOwn(entry[field] ?? {}, name) &&
        !(field === "peerDependencies" && entry.peerDependenciesMeta?.[name]?.optional));
    if (!depends) return false;
    // Node resolution: the nearest node_modules/<name> from the dependent upward.
    for (let base = path; ; ) {
      const candidate = `${base ? `${base}/` : ""}node_modules/${name}`;
      if (Object.hasOwn(lockfile.packages, candidate)) return candidate === node;
      if (!base) return false;
      const at = base.lastIndexOf("node_modules/");
      base = at > 0 ? base.slice(0, at - 1) : "";
    }
  }).map(([path]) => path);
};
// An entry with `through` covers a finding only when every installed copy npm
// reports for it has dependents, all under one of those paths.
const isExcepted = (via, vulnerability) => {
  const exception = ADVISORY_EXCEPTIONS.get(via.url);
  return exception?.severity === via.severity && (!exception.through ||
    (Array.isArray(vulnerability.nodes) && vulnerability.nodes.length > 0 &&
      vulnerability.nodes.every((node) => {
        const dependents = dependentsOf(node);
        return dependents.length > 0 && dependents.every((path) =>
          exception.through.some((root) => path === root || path.startsWith(`${root}/`)));
      })));
};
const memo = new Map();
// The excepted advisories a finding reaches, or null when any of its paths leads
// to another advisory, or when npm rates it above the most severe of them.
// npm can rate a dependent below the advisory it reaches.
const exceptionsOf = (name, active = new Set()) => {
  if (memo.has(name)) return memo.get(name);
  const vulnerability = vulnerabilities[name];
  if (!vulnerability || active.has(name) || vulnerability.via.length === 0) return null;

  const nextActive = new Set(active).add(name);
  let reached = new Set();
  for (const via of vulnerability.via) {
    const advisories = typeof via === "string"
      ? exceptionsOf(via, nextActive)
      : isExcepted(via, vulnerability) ? [via.url] : null;
    if (!advisories) {
      reached = null;
      break;
    }
    for (const advisory of advisories) reached.add(advisory);
  }
  if (reached && rank(vulnerability.severity) >
    Math.max(...[...reached].map((advisory) => rank(ADVISORY_EXCEPTIONS.get(advisory).severity)))) {
    reached = null;
  }
  memo.set(name, reached);
  return reached;
};

const unexpected = Object.keys(vulnerabilities).filter(
  (name) => !exceptionsOf(name),
);
if (unexpected.length > 0) {
  console.error("Unexpected production vulnerabilities:");
  for (const name of unexpected) {
    console.error(`- ${name}: ${vulnerabilities[name].severity}`);
  }
  process.exit(1);
}

const excepted = new Set(Object.keys(vulnerabilities).flatMap((name) => [...exceptionsOf(name)]));
if (excepted.size === 0) {
  console.log("Production dependency audit passed.");
} else {
  const notes = [...ADVISORY_EXCEPTIONS].filter(([advisory]) => excepted.has(advisory)).map(([, { note }]) => note);
  console.warn(
    `Production audit passed with fail-closed exceptions for advisories with no patched release: ${notes.join("; ")}.`,
  );
}
