/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The catalogue supplies defaults and presentation. Firefox's search service
 * owns engines, submissions, encoding, history, and user changes.
 */
export const SITE_SEARCH_DEFAULTS = Object.freeze(
  [
    {
      name: "YouTube",
      domain: "youtube.com",
      url: "https://www.youtube.com/results?search_query={searchTerms}",
      accent: "#d90000",
    },
  ].map(provider => Object.freeze(provider))
);

/**
 * @param {string} host A hostname.
 * @returns {string} Host without a www prefix, in lowercase.
 */
export function normalizeSiteSearchHost(host) {
  return host.toLowerCase().replace(/^www\./, "");
}

/**
 * Find sites by ordinary name or domain prefixes. Several matches can be
 * offered together; selecting a suggestion resolves the ambiguity.
 *
 * @param {string} value The user's search text.
 * @param {object[]} providers Available providers with names and domains.
 * @returns {object[]} Matching providers, with exact matches first.
 */
export function findSiteSearches(value, providers) {
  const text = normalizeSiteSearchHost(value.trim());
  if (!text || /[:/?#@]/.test(text)) {
    return [];
  }
  const words = text.split(/\s+/);
  const score = provider => {
    const name = provider.name.toLowerCase();
    const domain = normalizeSiteSearchHost(provider.domain);
    if (name == text || domain == text) {
      return 2;
    }
    const domainLabels = domain
      .split(".")
      .slice(0, -1)
      .filter(label => !["com", "co", "org", "net"].includes(label));
    const labels = [...name.split(/[^\p{L}\p{N}]+/u), ...domainLabels];
    return words.every(word => labels.some(label => label.startsWith(word))) ||
      domain.startsWith(text)
      ? 1
      : 0;
  };
  return providers
    .map(provider => ({ provider, score: score(provider) }))
    .filter(match => match.score)
    .sort(
      (a, b) =>
        b.score - a.score || a.provider.name.localeCompare(b.provider.name)
    )
    .map(match => match.provider);
}

/**
 * Describe an installed engine without making a search request. Engines with
 * POST submissions still work: the URL is used only to identify the domain.
 *
 * @param {object} engine A Firefox SearchEngine.
 * @param {boolean} [includeHidden] Include hidden engines when checking defaults.
 * @returns {object|null} A provider description, or null for an unsupported engine.
 */
export function describeSiteSearchEngine(engine, includeHidden = false) {
  if (engine.hidden && !includeHidden) {
    return null;
  }
  try {
    const url = new URL(engine.getSubmission("", "text/html")?.uri.spec);
    if (url.protocol != "https:" && url.protocol != "http:") {
      return null;
    }
    const domain = normalizeSiteSearchHost(url.hostname);
    const preset = SITE_SEARCH_DEFAULTS.find(p => p.domain == domain);
    if (!preset) {
      return null;
    }
    return {
      name: engine.name,
      engineName: engine.name,
      domain,
      homepage: `${url.origin}/`,
      accent: preset.accent,
    };
  } catch {
    return null;
  }
}
