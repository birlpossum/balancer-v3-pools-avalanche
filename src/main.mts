import fetch from "node-fetch";
import { ContractTag, ITagService } from "atq-types";

// Balancer v3 Pools on Avalanche C-Chain only (chainId 43114)
// Using the official Balancer Subgraphs from https://docs.balancer.fi/data-and-analytics/data-and-analytics/subgraph.html
// Note: We keep the gateway format that requires an API key, replacing [api-key] at runtime.
const SUBGRAPH_URLS: Record<string, { pools: string; vaults: string }> = {
  "43114": {
    // Existing pools subgraph (no names on Pool entity)
    pools:
      "https://gateway.thegraph.com/api/[api-key]/deployments/id/QmchdxtRDQJxtt8VkV5MSmcUPvLmo1wgXD7Y7ZCNKNebN1",
    // Vaults subgraph (contains Pool name/symbol/address we need)
    vaults:
      "https://gateway.thegraph.com/api/[api-key]/deployments/id/QmSj437ejL2f1pMP2r5E2m5GjhqJa3rmbvFD5kyscmq7u2",
  },
};

// v3 schema does not expose symbol/createTime/tokens on Pool.
// Minimal type set for what we query below.
interface FactoryInfo {
  type: string; // PoolType enum as string
  version: number;
}

// Fetch all pool names from the Vaults subgraph and return a lookup by lowercase address
async function fetchPoolNamesMap(subgraphUrl: string): Promise<Map<string, { name: string; symbol: string }>> {
  const names = new Map<string, { name: string; symbol: string }>();
  let lastId = "0x0000000000000000000000000000000000000000";
  let isMore = true;

  while (isMore) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let response: any;
    try {
      response = await fetch(subgraphUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: GET_VAULTS_POOL_NAMES_QUERY,
          variables: { lastId },
        }),
        signal: controller.signal,
      } as any);
    } catch (e: any) {
      clearTimeout(timeout);
      if (e?.name === "AbortError") {
        throw new Error("Request timed out while querying the vaults subgraph.");
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new Error(`HTTP error (vaults): ${response.status}`);
    }
    const result = (await response.json()) as VaultsGraphQLResponse;
    if (result.errors) {
      result.errors.forEach((error) => console.error(`GraphQL error (vaults): ${error.message}`));
      throw new Error("GraphQL error from vaults subgraph.");
    }
    const page = result.data?.pools ?? [];
    for (const p of page) {
      if (p?.address && p?.name) {
        names.set(String(p.address).toLowerCase(), { name: p.name, symbol: p.symbol });
      }
    }
    isMore = page.length === 1000;
    if (isMore) {
      const nextLastId = page[page.length - 1].id;
      if (!nextLastId || nextLastId === lastId) {
        throw new Error("Pagination cursor (vaults) did not advance; aborting.");
      }
      lastId = nextLastId;
    }
  }
  return names;
}

// Optional param shapes for constructing richer name tags
interface StableParamsInfo { amp: string }
interface WeightedParamsInfo { weights: string[] }
interface Gyro2ParamsInfo { sqrtAlpha: string; sqrtBeta: string }
interface GyroEParamsInfo { alpha: string; beta: string }
interface LBPParamsInfo { owner: string; projectToken: string; reserveToken: string }
interface QuantAMMWeightedParamsInfo { epsilonMax: string; maxTradeSizeRatio: string }
interface ReClammParamsInfo { lastTimestamp: string }

interface Pool {
  id: string; // Bytes
  address: string; // Bytes
  factory: FactoryInfo;
  stableParams?: StableParamsInfo | null;
  weightedParams?: WeightedParamsInfo | null;
  gyro2Params?: Gyro2ParamsInfo | null;
  gyroEParams?: GyroEParamsInfo | null;
  lbpParams?: LBPParamsInfo | null;
  quantAMMWeightedParams?: QuantAMMWeightedParamsInfo | null;
  reClammParams?: ReClammParamsInfo | null;
}

interface GraphQLData {
  pools: Pool[];
}

interface GraphQLResponse {
  data?: GraphQLData;
  errors?: { message: string }[]; // Assuming the API might return errors in this format
}
//defining headers for query
const headers: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json",
};

// v3: cursor-based pagination using id_gt; fetch core identifiers, factory info, and type-specific params
const GET_POOLS_QUERY = `
  query GetPools($lastId: ID) {
    pools(
      first: 1000,
      orderBy: id,
      orderDirection: asc,
      where: { id_gt: $lastId }
    ) {
      id
      address
      factory { type version }
      stableParams { amp }
      weightedParams { weights }
      gyro2Params { sqrtAlpha sqrtBeta }
      gyroEParams { alpha beta }
      lbpParams { owner projectToken reserveToken }
      quantAMMWeightedParams { epsilonMax maxTradeSizeRatio }
      reClammParams { lastTimestamp }
    }
  }
`;

// Minimal type and query to fetch Pool names from the Vaults subgraph
interface VaultsPoolNameInfo {
  id: string;
  address: string;
  name: string;
  symbol: string;
}

interface VaultsGraphQLData {
  pools: VaultsPoolNameInfo[];
}

interface VaultsGraphQLResponse {
  data?: VaultsGraphQLData;
  errors?: { message: string }[];
}

const GET_VAULTS_POOL_NAMES_QUERY = `
  query GetVaultsPools($lastId: ID) {
    pools(
      first: 1000,
      orderBy: id,
      orderDirection: asc,
      where: { id_gt: $lastId }
    ) {
      id
      address
      name
      symbol
    }
  }
`;

function isError(e: unknown): e is Error {
  return (
    typeof e === "object" &&
    e !== null &&
    "message" in e &&
    typeof (e as Error).message === "string"
  );
}

const camelCaseToSpaced = (input: string): string => {
  // This regular expression finds all occurrences where a lowercase letter or a number is directly followed by an uppercase letter and inserts a space between them.
  return input.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
};

async function fetchData(
  subgraphUrl: string,
  lastId: string
): Promise<Pool[]> {
  // Add a reasonable timeout to avoid hanging indefinitely
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000); // 30s
  let response: any;
  try {
    response = await fetch(subgraphUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: GET_POOLS_QUERY,
        variables: { lastId },
      }),
      signal: controller.signal,
    } as any);
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error("Request timed out while querying the subgraph.");
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status}`);
  }

  const result = (await response.json()) as GraphQLResponse;
  if (result.errors) {
    result.errors.forEach((error) => {
      console.error(`GraphQL error: ${error.message}`);
    });
    throw new Error("GraphQL errors occurred: see logs for details.");
  }
  if (!result.data || !result.data.pools) {
    throw new Error("No pools data found.");
  }
  return result.data.pools;
}

function prepareUrl(chainId: string, apiKey: string): string {
  // Only Avalanche C-Chain (43114) is supported for v3 in this module.
  const urls = SUBGRAPH_URLS[chainId];
  if (!urls) {
    throw new Error(`Unsupported Chain ID: ${chainId}.`);
  }
  // Maintain function for backward-compatibility; returns the Pools subgraph URL
  return urls.pools.replace("[api-key]", encodeURIComponent(apiKey));
}

function truncateString(text: string, maxLength: number) {
  if (text.length > maxLength) {
    return text.substring(0, maxLength - 3) + "..."; // Subtract 3 for the ellipsis
  }
  return text;
}
function containsHtmlOrMarkdown(text: string): boolean {
  // Enhanced HTML tag detection that requires at least one character inside the brackets
  if (/<[^>]+>/.test(text)) {
    return true;
  }
  return false;
}

// Abbreviate numeric strings for compact display in name tags
function abbreviateNumberString(input: string): string {
  const n = Number(input);
  if (!isFinite(n)) return input;
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    return `${Math.round(n / 1_000_000)}M`;
  }
  if (abs >= 1_000) {
    return `${Math.round(n / 1_000)}k`;
  }
  // Clamp decimals to max 4 significant decimals for small numbers
  if (abs < 1) {
    return Number(n.toPrecision(4)).toString();
  }
  // For 1 to 999.999, keep up to 4 decimal places if present
  const fixed = Math.abs(n % 1) > 0 ? n.toFixed(4) : n.toString();
  return fixed.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

// Build a compact, type-specific params snippet, already abbreviated
function buildParamsSnippet(pool: Pool): string {
  switch (pool.factory.type) {
    case "Stable": {
      const amp = pool.stableParams?.amp;
      return amp ? `amp=${abbreviateNumberString(amp)}` : "";
    }
    case "Weighted": {
      const n = pool.weightedParams?.weights?.length;
      return typeof n === "number" ? `weights=${n}` : "";
    }
    case "Gyro2": {
      const a = pool.gyro2Params?.sqrtAlpha;
      const b = pool.gyro2Params?.sqrtBeta;
      return a && b
        ? `sA=${abbreviateNumberString(a)}, sB=${abbreviateNumberString(b)}`
        : "";
    }
    case "GyroE": {
      const a = pool.gyroEParams?.alpha;
      const b = pool.gyroEParams?.beta;
      return a && b
        ? `a=${abbreviateNumberString(a)}, b=${abbreviateNumberString(b)}`
        : "";
    }
    case "QuantAMMWeighted": {
      const e = pool.quantAMMWeightedParams?.epsilonMax;
      const m = pool.quantAMMWeightedParams?.maxTradeSizeRatio;
      return e && m
        ? `eMax=${abbreviateNumberString(e)}, mTSR=${abbreviateNumberString(m)}`
        : "";
    }
    case "LBP": {
      // Addresses are long; avoid including them in the name tag to respect 50-char cap
      return "";
    }
    case "ReClamm": {
      const ts = pool.reClammParams?.lastTimestamp;
      return ts ? `ts=${abbreviateNumberString(ts)}` : "";
    }
    default:
      return "";
  }
}

// Local helper function used by returnTags
function transformPoolsToTags(
  chainId: string,
  pools: Pool[],
  namesMap?: Map<string, { name: string; symbol: string }>
): ContractTag[] {
  const validPools: Pool[] = [];

  pools.forEach((pool) => {
    const typeText = pool.factory?.type ?? "";
    const poolTypeInvalid = containsHtmlOrMarkdown(typeText) || !typeText;

    // Policy: We do NOT artificially limit/skip entries. The only case we skip
    // is when the data would lead to invalid entries, e.g., missing factory.type
    // or content containing HTML/markdown (potentially malicious). This aligns
    // with the rule allowing skipping subsets that would be invalid.
    if (poolTypeInvalid) {
      console.log(
        "Pool rejected due to invalid factory type: " + JSON.stringify(pool)
      );
    } else {
      validPools.push(pool);
    }
  });

  return validPools.map((pool) => {
    const typeText = camelCaseToSpaced(pool.factory.type);

    // Build abbreviated, type-specific params
    const paramsSnippet = buildParamsSnippet(pool);

    // New policy: Public Name Tag should be '<TokenNames> Pool' only, max 50 chars.
    const rawPoolName = namesMap?.get(String(pool.address).toLowerCase())?.name?.trim() ?? "";
    const suffix = " Pool";
    const maxLen = 50;
    let tokenPart = rawPoolName;
    if (tokenPart.length + suffix.length > maxLen) {
      const allowedTokenLen = Math.max(0, maxLen - suffix.length);
      // Ensure space for ellipsis within the token name portion
      if (allowedTokenLen >= 3) {
        tokenPart = tokenPart.substring(0, allowedTokenLen - 3) + "...";
      } else {
        // If extremely constrained, fall back to just 'Pool'
        tokenPart = "";
      }
    }
    const nameTag = (tokenPart ? `${tokenPart}${suffix}` : `Pool`);

    // Move all detailed info to Public Note
    const versionText = typeof pool.factory.version === "number" ? ` v${pool.factory.version}` : "";
    const paramsNote = paramsSnippet && paramsSnippet.trim().length > 0 ? ` Params: ${paramsSnippet}.` : "";
    const nameNote = rawPoolName ? ` Name: ${rawPoolName}.` : "";
    const publicNote = `A Balancer v3 '${typeText}' pool${versionText}.${nameNote}${paramsNote}`;

    // Note that Balancer v3 does not expose tokens on Pool, so these are not included in the name tag.
    return {
      "Contract Address": `eip155:${chainId}:${pool.address}`,
      "Public Name Tag": nameTag,
      "Project Name": "Balancer v3",
      "UI/Website Link": "https://balancer.fi",
      "Public Note": publicNote,
    };
  });
}

// The main logic for this module
class TagService implements ITagService {
  // Using an arrow function for returnTags
  returnTags = async (
    chainId: string,
    apiKey: string
  ): Promise<ContractTag[]> => {
    // Argument validation per policy: throw on invalid inputs
    const chainIdNum = Number(chainId);
    if (!Number.isInteger(chainIdNum)) {
      throw new Error(`Unsupported Chain ID: ${chainId}.`);
    }
    if (chainIdNum !== 43114) {
      throw new Error(`Unsupported Chain ID: ${chainId}.`);
    }
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error("Missing API key. A The Graph gateway API key is required.");
    }

    // v3: use cursor-based pagination (id_gt) per policy
    let lastId = "0x0000000000000000000000000000000000000000"; // lowest Bytes value
    let prevLastId = "";
    // Accumulate all pools first so we can enrich with names from the Vaults subgraph
    const allPools: Pool[] = [];
    // Policy: do not return duplicates for the same chain. Deduplicate early by pool.id
    // (which equals the pool contract address in this subgraph) to avoid building tags
    // for duplicates.
    const seenPoolIds = new Set<string>();
    let isMore = true;

    // Use the validated provided chainId (policy: throw if unsupported)
    const effectiveChainId = String(chainIdNum);
    const poolsUrl = SUBGRAPH_URLS[effectiveChainId]?.pools?.replace("[api-key]", apiKey);
    const vaultsUrl = SUBGRAPH_URLS[effectiveChainId]?.vaults?.replace("[api-key]", apiKey);
    if (!poolsUrl || !vaultsUrl) {
      throw new Error("Missing subgraph URLs for the specified chain.");
    }

    while (isMore) {
      try {
        const pools = await fetchData(poolsUrl, lastId);
        const newPools = pools.filter((p) => {
          if (seenPoolIds.has(p.id)) {
            // Policy: skip duplicates identified by pool.id
            return false;
          }
          seenPoolIds.add(p.id);
          return true;
        });
        allPools.push(...newPools);

        isMore = pools.length === 1000;
        if (isMore) {
          const nextLastId = pools[pools.length - 1].id;
          // Safety: ensure the cursor advances; otherwise throw to avoid infinite loops
          if (!nextLastId || nextLastId === lastId || nextLastId === prevLastId) {
            throw new Error(
              "Pagination cursor did not advance; aborting to prevent an infinite loop."
            );
          }
          prevLastId = lastId;
          lastId = nextLastId;
        }
      } catch (error) {
        if (isError(error)) {
          console.error(`An error occurred: ${error.message}`);
          throw new Error(`Failed fetching data: ${error}`); // Propagate a new error with more context
        } else {
          console.error("An unknown error occurred.");
          throw new Error("An unknown error occurred during fetch operation."); // Throw with a generic error message if the error type is unknown
        }
      }
    }
    // Fetch names from the Vaults subgraph and build the lookup map
    const namesMap = await fetchPoolNamesMap(vaultsUrl);
    // Now transform pools to tags using the names
    const allTags = transformPoolsToTags(effectiveChainId, allPools, namesMap);
    return allTags;
  };
}

// Creating an instance of TagService
const tagService = new TagService();

// Exporting the returnTags method directly
export const returnTags = tagService.returnTags;